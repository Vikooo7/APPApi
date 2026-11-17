// Núcleo de Banco Andino (simulado). Es un "banco" aparte de RutaLog: tiene sus propias tablas (banco_*),
// su propia clave para servidores y su propio inicio de sesión de clientes. RutaLog lo llama por HTTP.
const crypto = require('crypto');

function error(estado, codigo, mensaje) {
  const e = new Error(mensaje);
  e.estado = estado;
  e.codigo = codigo;
  return e;
}

const PREFIJO_QR = 'BANCOANDINO:';
const TASA_ANUAL = 0.18; // tasa efectiva anual de los créditos vehiculares (simulada)
const CUENTA_RUTALOG = '191-1000001-0';

/** Céntimos exactos: el dinero nunca se calcula con decimales flotantes sueltos (RNF-09). */
const redondear = (monto) => Math.round(Number(monto) * 100) / 100;

function leerMonto(valor, nombre = 'El monto') {
  const monto = Number(valor);
  if (!Number.isFinite(monto) || monto <= 0) throw error(422, 'MONTO_INVALIDO', `${nombre} debe ser mayor que 0.`);
  if (Math.abs(Math.round(monto * 100) - monto * 100) > 1e-6) {
    throw error(422, 'MONTO_INVALIDO', `${nombre} admite como máximo 2 decimales.`);
  }
  if (monto > 1_000_000) throw error(422, 'MONTO_INVALIDO', `${nombre} supera el máximo permitido.`);
  return redondear(monto);
}

/** "BANCOANDINO:QR-1A2B3C4D5E" o "QR-1A2B3C4D5E" → "QR-1A2B3C4D5E". */
function idDeCodigo(codigo) {
  const texto = String(codigo || '').trim().toUpperCase();
  const id = texto.startsWith(PREFIJO_QR) ? texto.slice(PREFIJO_QR.length) : texto;
  if (!/^QR-[0-9A-F]{10}$/.test(id)) throw error(422, 'QR_INVALIDO', 'El código QR no es de Banco Andino.');
  return id;
}

/** 191-2604001-0 → ***-***4001-0 (para mostrar sin exponer la cuenta completa). */
function enmascararCuenta(numero) {
  const texto = String(numero || '');
  return texto.length > 6 ? `***-***${texto.slice(-6)}` : texto;
}

/** Cuota fija mensual (sistema francés). */
function cuotaMensual(monto, plazoMeses, tasaAnual = TASA_ANUAL) {
  const i = Math.pow(1 + tasaAnual, 1 / 12) - 1; // tasa mensual equivalente a la efectiva anual
  return redondear((monto * i) / (1 - Math.pow(1 + i, -plazoMeses)));
}

/** Cronograma de pagos: capital, interés y saldo de cada mes. La última cuota absorbe el redondeo. */
function cronograma(monto, plazoMeses, desde = new Date(), tasaAnual = TASA_ANUAL) {
  const i = Math.pow(1 + tasaAnual, 1 / 12) - 1;
  const cuota = cuotaMensual(monto, plazoMeses, tasaAnual);
  let saldo = redondear(monto);
  const filas = [];
  for (let n = 1; n <= plazoMeses; n++) {
    const interes = redondear(saldo * i);
    const capital = n === plazoMeses ? saldo : redondear(cuota - interes);
    saldo = redondear(saldo - capital);
    const fecha = new Date(desde);
    fecha.setMonth(fecha.getMonth() + n);
    filas.push({ numero: n, fecha: fecha.toISOString().slice(0, 10), cuota: redondear(capital + interes), capital, interes, saldo });
  }
  return filas;
}

async function nuevoNumeroOperacion(bd) {
  const { rows } = await bd.query("SELECT 'BA-' || nextval('banco_nro_seq') AS nro");
  return rows[0].nro;
}

/**
 * Mueve dinero entre cuentas en la transacción bd. origen null = fondos del banco (desembolso, depósito).
 * Bloquea las cuentas en orden fijo para que dos pagos simultáneos no se crucen. Devuelve el número de operación.
 */
async function mover(bd, { tipo, origen, destino, monto, concepto, referencia, uuid }) {
  const cuentas = [origen, destino].filter(Boolean).sort();
  const { rows } = await bd.query('SELECT numero, saldo, titular FROM banco_cuentas WHERE numero = ANY($1) ORDER BY numero FOR UPDATE', [
    cuentas
  ]);
  const porNumero = new Map(rows.map((c) => [c.numero, c]));
  if (!porNumero.has(destino)) throw error(404, 'CUENTA_NO_EXISTE', `La cuenta ${destino} no existe en Banco Andino.`);
  if (origen && !porNumero.has(origen)) throw error(404, 'CUENTA_NO_EXISTE', `La cuenta ${origen} no existe en Banco Andino.`);
  if (origen === destino) throw error(422, 'MISMA_CUENTA', 'La cuenta de origen y la de destino son la misma.');
  if (origen && Number(porNumero.get(origen).saldo) < monto) {
    throw error(409, 'SALDO_INSUFICIENTE', 'Saldo insuficiente para esta operación.');
  }

  const nro = await nuevoNumeroOperacion(bd);
  await bd.query(
    `INSERT INTO banco_operaciones (nro, tipo, cuenta_origen, cuenta_destino, monto, concepto, referencia, uuid)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [nro, tipo, origen || null, destino, monto, concepto, referencia || null, uuid || null]
  );
  const asentar = async (cuenta, importe, descripcion) => {
    const { rows: r } = await bd.query('UPDATE banco_cuentas SET saldo = saldo + $1 WHERE numero = $2 RETURNING saldo', [importe, cuenta]);
    await bd.query(
      'INSERT INTO banco_movimientos (cuenta, nro_operacion, descripcion, monto, saldo) VALUES ($1, $2, $3, $4, $5)',
      [cuenta, nro, descripcion, importe, r[0].saldo]
    );
  };
  if (origen) await asentar(origen, -monto, `${concepto} · a ${porNumero.get(destino).titular}`);
  await asentar(destino, monto, origen ? `${concepto} · de ${porNumero.get(origen).titular}` : concepto);
  return nro;
}

/** Cobro QR por un monto exacto a favor de una cuenta comercio (RutaLog). */
async function crearCobroQr(bd, { cuentaComercio = CUENTA_RUTALOG, monto, concepto, referencia, venceEnMin }) {
  const importe = leerMonto(monto);
  const texto = String(concepto || '').trim();
  if (!texto) throw error(422, 'CONCEPTO_REQUERIDO', 'Indica el concepto del cobro.');
  const minutos = Math.min(Math.max(Number(venceEnMin) || 24 * 60, 5), 7 * 24 * 60);
  const comercio = await bd.query("SELECT numero FROM banco_cuentas WHERE numero = $1 AND tipo = 'empresa'", [cuentaComercio]);
  if (!comercio.rows[0]) throw error(404, 'COMERCIO_NO_EXISTE', 'La cuenta comercio no existe.');

  const id = `QR-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
  const { rows } = await bd.query(
    `INSERT INTO banco_cobros_qr (id, cuenta_comercio, monto, concepto, referencia, vence_en)
     VALUES ($1, $2, $3, $4, $5, NOW() + make_interval(mins => $6)) RETURNING *`,
    [id, cuentaComercio, importe, texto.slice(0, 120), referencia ? String(referencia).slice(0, 60) : null, minutos]
  );
  return cobroAJson(rows[0]);
}

function cobroAJson(fila, titularComercio) {
  const vencido = fila.estado === 'PENDIENTE' && new Date(fila.vence_en) < new Date();
  return {
    id: fila.id,
    codigoQr: PREFIJO_QR + fila.id,
    comercio: titularComercio || undefined,
    monto: Number(fila.monto),
    concepto: fila.concepto,
    referencia: fila.referencia,
    estado: vencido ? 'VENCIDO' : fila.estado,
    nroOperacion: fila.nro_operacion,
    venceEn: fila.vence_en,
    pagadoEn: fila.pagado_en
  };
}

async function obtenerCobro(bd, codigo) {
  const id = idDeCodigo(codigo);
  const { rows } = await bd.query(
    `SELECT q.*, c.titular FROM banco_cobros_qr q JOIN banco_cuentas c ON c.numero = q.cuenta_comercio WHERE q.id = $1`,
    [id]
  );
  if (!rows[0]) throw error(404, 'QR_NO_EXISTE', 'Ese cobro QR no existe en Banco Andino.');
  return cobroAJson(rows[0], rows[0].titular);
}

/** El cliente del banco paga un QR desde su billetera. Repetir con el mismo uuid no cobra dos veces. */
async function pagarCobro(bd, { codigo, clienteId, uuid }) {
  if (!/^[0-9a-f-]{36}$/i.test(String(uuid || ''))) throw error(422, 'UUID_REQUERIDO', 'Falta el identificador único del pago.');
  const repetido = await bd.query('SELECT nro, monto FROM banco_operaciones WHERE uuid = $1', [uuid]);
  if (repetido.rows[0]) return { nroOperacion: repetido.rows[0].nro, monto: Number(repetido.rows[0].monto), duplicado: true };

  const id = idDeCodigo(codigo);
  const { rows } = await bd.query('SELECT * FROM banco_cobros_qr WHERE id = $1 FOR UPDATE', [id]);
  const cobro = rows[0];
  if (!cobro) throw error(404, 'QR_NO_EXISTE', 'Ese cobro QR no existe en Banco Andino.');
  if (cobro.estado === 'PAGADO') throw error(409, 'QR_PAGADO', `Este QR ya fue pagado (operación ${cobro.nro_operacion}).`);
  if (cobro.estado !== 'PENDIENTE') throw error(409, 'QR_ANULADO', 'Este cobro fue anulado.');
  if (new Date(cobro.vence_en) < new Date()) throw error(409, 'QR_VENCIDO', 'Este QR venció. Pide uno nuevo.');

  const cuenta = await bd.query(
    "SELECT numero FROM banco_cuentas WHERE cliente_id = $1 ORDER BY (tipo = 'personal') DESC, numero LIMIT 1",
    [clienteId]
  );
  if (!cuenta.rows[0]) throw error(404, 'SIN_CUENTA', 'No tienes una cuenta en Banco Andino.');

  const nro = await mover(bd, {
    tipo: 'PAGO_QR',
    origen: cuenta.rows[0].numero,
    destino: cobro.cuenta_comercio,
    monto: Number(cobro.monto),
    concepto: cobro.concepto,
    referencia: cobro.referencia,
    uuid
  });
  await bd.query("UPDATE banco_cobros_qr SET estado = 'PAGADO', nro_operacion = $1, pagado_en = NOW() WHERE id = $2", [nro, id]);
  const saldo = await bd.query('SELECT saldo FROM banco_cuentas WHERE numero = $1', [cuenta.rows[0].numero]);
  return { nroOperacion: nro, monto: Number(cobro.monto), saldo: Number(saldo.rows[0].saldo), concepto: cobro.concepto };
}

/** Verificación de una operación por su número (RNF-05: RutaLog no acepta un pago sin preguntar al banco). */
async function obtenerOperacion(bd, nro) {
  const texto = String(nro || '').trim().toUpperCase();
  if (!/^BA-\d{3,12}$/.test(texto)) throw error(422, 'NRO_INVALIDO', 'El número de operación tiene la forma BA-44102.');
  const { rows } = await bd.query('SELECT * FROM banco_operaciones WHERE nro = $1', [texto]);
  if (!rows[0]) throw error(404, 'OPERACION_NO_EXISTE', `La operación ${texto} no existe en Banco Andino.`);
  const op = rows[0];
  return {
    nro: op.nro,
    tipo: op.tipo,
    cuentaOrigen: op.cuenta_origen ? enmascararCuenta(op.cuenta_origen) : null,
    cuentaDestino: op.cuenta_destino,
    monto: Number(op.monto),
    concepto: op.concepto,
    referencia: op.referencia,
    fecha: op.fecha
  };
}

/** Liquidación a remitentes: varias transferencias desde la cuenta de RutaLog, todas o ninguna. */
async function transferirLote(bd, { cuentaOrigen = CUENTA_RUTALOG, transferencias, uuid }) {
  if (!Array.isArray(transferencias) || transferencias.length === 0) {
    throw error(422, 'LOTE_VACIO', 'El lote no tiene transferencias.');
  }
  if (transferencias.length > 200) throw error(422, 'LOTE_GRANDE', 'Máximo 200 transferencias por lote.');
  // Un lote reenviado (por ejemplo, tras un corte de red) devuelve lo que ya se transfirió, sin pagar dos veces.
  if (uuid) {
    await bd.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`lote:${uuid}`]);
    const previo = await bd.query('SELECT resultados FROM banco_lotes WHERE uuid = $1', [uuid]);
    if (previo.rows[0]) return { duplicado: true, resultados: previo.rows[0].resultados };
  }
  const resultados = [];
  for (const [i, t] of transferencias.entries()) {
    const monto = leerMonto(t.monto, `El monto de la transferencia ${i + 1}`);
    const nro = await mover(bd, {
      tipo: 'TRANSFERENCIA',
      origen: cuentaOrigen,
      destino: String(t.cuentaDestino || ''),
      monto,
      concepto: String(t.concepto || 'Transferencia').slice(0, 120),
      referencia: t.referencia ? String(t.referencia).slice(0, 60) : null,
      uuid: null
    });
    resultados.push({ referencia: t.referencia || null, cuentaDestino: t.cuentaDestino, monto, nroOperacion: nro });
  }
  if (uuid) await bd.query('INSERT INTO banco_lotes (uuid, resultados) VALUES ($1, $2)', [uuid, JSON.stringify(resultados)]);
  return { resultados };
}

async function cuentaExiste(bd, numero) {
  const { rows } = await bd.query('SELECT numero, titular, tipo FROM banco_cuentas WHERE numero = $1', [String(numero || '').trim()]);
  return rows[0] ? { existe: true, numero: rows[0].numero, titular: rows[0].titular, tipo: rows[0].tipo } : { existe: false };
}

function creditoAJson(c) {
  const monto = Number(c.monto);
  const aprobado = c.estado === 'APROBADO' || c.estado === 'DESEMBOLSADO';
  return {
    id: c.id,
    solicitante: c.solicitante,
    cuenta: c.cuenta,
    monto,
    plazoMeses: c.plazo_meses,
    proposito: c.proposito,
    estado: c.estado,
    tasaAnual: Number(c.tasa_anual),
    cuota: aprobado ? cuotaMensual(monto, c.plazo_meses, Number(c.tasa_anual)) : null,
    comentario: c.comentario,
    nroDesembolso: c.nro_desembolso,
    // RN-07: el banco solo recibe totales por mes, nunca datos de los clientes de RutaLog.
    facturacion: c.facturacion,
    creadoEn: c.creado_en,
    decididoEn: c.decidido_en,
    cronograma: aprobado ? cronograma(monto, c.plazo_meses, new Date(c.decidido_en || Date.now()), Number(c.tasa_anual)) : []
  };
}

/** Solicitud de crédito: el comité la decide en la web (RN-08). */
async function solicitarCredito(bd, { cuenta = CUENTA_RUTALOG, solicitante, monto, plazoMeses, proposito, facturacion }) {
  const importe = leerMonto(monto);
  const plazo = Number(plazoMeses);
  if (!Number.isInteger(plazo) || plazo < 6 || plazo > 84) throw error(422, 'PLAZO_INVALIDO', 'El plazo va de 6 a 84 meses.');
  if (!Array.isArray(facturacion) || facturacion.length === 0) {
    throw error(422, 'SIN_FACTURACION', 'Falta la facturación mensual autorizada.');
  }
  const meses = facturacion.slice(0, 24).map((f) => ({
    mes: String(f.mes || '').slice(0, 7),
    facturacion: redondear(f.facturacion || 0),
    envios: Math.max(0, Math.trunc(Number(f.envios) || 0))
  }));
  const existe = await cuentaExiste(bd, cuenta);
  if (!existe.existe) throw error(404, 'CUENTA_NO_EXISTE', 'La cuenta para el desembolso no existe.');
  const { rows: sec } = await bd.query("SELECT 'CR-' || LPAD(nextval('banco_credito_seq')::text, 4, '0') AS id");
  const { rows } = await bd.query(
    `INSERT INTO banco_creditos (id, cuenta, solicitante, monto, plazo_meses, tasa_anual, proposito, facturacion)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [sec[0].id, cuenta, String(solicitante || existe.titular).slice(0, 80), importe, plazo, TASA_ANUAL, String(proposito || 'Crédito').slice(0, 200), JSON.stringify(meses)]
  );
  return creditoAJson(rows[0]);
}

async function obtenerCredito(bd, id) {
  const { rows } = await bd.query('SELECT * FROM banco_creditos WHERE id = $1', [String(id || '').toUpperCase()]);
  if (!rows[0]) throw error(404, 'CREDITO_NO_EXISTE', 'Esa solicitud de crédito no existe.');
  return creditoAJson(rows[0]);
}

async function listarCreditos(bd) {
  const { rows } = await bd.query('SELECT * FROM banco_creditos ORDER BY creado_en DESC LIMIT 100');
  return rows.map(creditoAJson);
}

/** El comité decide. Si aprueba, el banco desembolsa en la cuenta en la misma operación. */
async function decidirCredito(bd, id, { decision, comentario }) {
  if (!['APROBADO', 'RECHAZADO'].includes(decision)) throw error(422, 'DECISION_INVALIDA', 'La decisión es APROBADO o RECHAZADO.');
  const { rows } = await bd.query('SELECT * FROM banco_creditos WHERE id = $1 FOR UPDATE', [String(id || '').toUpperCase()]);
  const credito = rows[0];
  if (!credito) throw error(404, 'CREDITO_NO_EXISTE', 'Esa solicitud de crédito no existe.');
  if (credito.estado !== 'EN_EVALUACION') throw error(409, 'CREDITO_DECIDIDO', `Esta solicitud ya está ${credito.estado}.`);
  let nro = null;
  if (decision === 'APROBADO') {
    nro = await mover(bd, {
      tipo: 'DESEMBOLSO',
      origen: null,
      destino: credito.cuenta,
      monto: Number(credito.monto),
      concepto: `Desembolso crédito ${credito.id}`,
      referencia: credito.id
    });
  }
  const actualizado = await bd.query(
    `UPDATE banco_creditos SET estado = $1, comentario = $2, nro_desembolso = $3, decidido_en = NOW() WHERE id = $4 RETURNING *`,
    [decision === 'APROBADO' ? 'DESEMBOLSADO' : 'RECHAZADO', comentario ? String(comentario).slice(0, 300) : null, nro, credito.id]
  );
  return creditoAJson(actualizado.rows[0]);
}

/** Saldo y últimos movimientos de las cuentas de un cliente (la billetera). */
async function resumenCliente(bd, clienteId) {
  const cliente = await bd.query('SELECT id, usuario, nombre FROM banco_clientes WHERE id = $1', [clienteId]);
  if (!cliente.rows[0]) throw error(404, 'CLIENTE_NO_EXISTE', 'El cliente no existe.');
  const cuentas = await bd.query('SELECT numero, tipo, titular, saldo FROM banco_cuentas WHERE cliente_id = $1 ORDER BY numero', [clienteId]);
  const numeros = cuentas.rows.map((c) => c.numero);
  const movimientos = await bd.query(
    `SELECT m.cuenta, m.nro_operacion, m.descripcion, m.monto, m.saldo, m.fecha
     FROM banco_movimientos m WHERE m.cuenta = ANY($1) ORDER BY m.fecha DESC, m.id DESC LIMIT 50`,
    [numeros]
  );
  return {
    cliente: { usuario: cliente.rows[0].usuario, nombre: cliente.rows[0].nombre },
    cuentas: cuentas.rows.map((c) => ({ numero: c.numero, tipo: c.tipo, titular: c.titular, saldo: Number(c.saldo) })),
    movimientos: movimientos.rows.map((m) => ({
      cuenta: m.cuenta,
      nroOperacion: m.nro_operacion,
      descripcion: m.descripcion,
      monto: Number(m.monto),
      saldo: Number(m.saldo),
      fecha: m.fecha
    }))
  };
}

module.exports = {
  error,
  PREFIJO_QR,
  CUENTA_RUTALOG,
  TASA_ANUAL,
  redondear,
  leerMonto,
  idDeCodigo,
  enmascararCuenta,
  cuotaMensual,
  cronograma,
  mover,
  crearCobroQr,
  obtenerCobro,
  pagarCobro,
  obtenerOperacion,
  transferirLote,
  cuentaExiste,
  solicitarCredito,
  obtenerCredito,
  listarCreditos,
  decidirCredito,
  resumenCliente
};
