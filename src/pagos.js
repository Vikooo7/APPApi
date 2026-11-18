// Pagos con Banco Andino (fase de pagos de la ficha). RutaLog nunca da por bueno un pago sin preguntarle
// al banco (RNF-05) y el dinero del contraentrega es del remitente: solo se liquida lo confirmado (RN-01, RN-04).
const crypto = require('crypto');
const express = require('express');
const { consulta, transaccion } = require('./db');
const { requiereSesion, error } = require('./auth');
const { crearClienteBanco } = require('./clienteBanco');
const { ejecutarUnaVez, esOperacion, obtenerParaEditar, leerFechaEvento } = require('./envios');
const { leerImagen, guardarArchivo } = require('./archivos');

// Cuenta de recaudo de RutaLog en Banco Andino: ahí deben llegar todos los pagos QR.
const CUENTA_RUTALOG = process.env.RUTALOG_CUENTA_BANCO || '191-1000001-0';
const redondear = (n) => Math.round(Number(n) * 100) / 100;

const esCourier = (req) => req.usuario.rol === 'courier';
const esCliente = (req) => req.usuario.rol === 'cliente';
const esAdministrador = (req) => req.usuario.rol === 'administrador';

function cobroAJson(c, envio) {
  return {
    id: c.id,
    envioId: c.envio_id,
    numeroGuia: envio?.numero_guia ?? c.numero_guia ?? null,
    tipo: c.tipo,
    monto: Number(c.monto),
    estado: c.estado,
    codigoQr: c.estado === 'POR_COBRAR' ? c.codigo_qr : null,
    nroOperacion: c.nro_operacion_banco,
    motivoRechazo: c.motivo_rechazo ?? null,
    creadoEn: c.creado_en,
    confirmadoEn: c.confirmado_en,
    liquidacionId: c.liquidacion_id ?? null
  };
}

async function envioPorId(id) {
  const { rows } = await consulta('SELECT * FROM envios WHERE id = $1 AND NOT eliminado', [Number(id)]);
  if (!rows[0]) throw error(404, 'NO_ENCONTRADO', 'El envío no existe en el servidor.');
  return rows[0];
}

/** Quién puede pedir cada QR: el remitente paga su envío; el courier asignado cobra el contraentrega. */
function validarPermisoCobro(req, envio, tipo) {
  if (tipo === 'envio') {
    if (!(esCliente(req) && envio.usuario_id === req.usuario.id) && !esOperacion(req)) {
      throw error(403, 'SIN_PERMISO', 'Solo el remitente paga el costo de su envío.');
    }
  } else if (!(esCourier(req) && envio.courier_id === req.usuario.id) && !esOperacion(req)) {
    throw error(403, 'SIN_PERMISO', 'Solo el courier asignado cobra el contraentrega.');
  }
}

/**
 * Confirma un cobro con el número de operación que dio el banco, después de verificarlo allá:
 * la operación debe existir, ser un pago QR a la cuenta de RutaLog y por el monto exacto.
 */
async function confirmarConBanco(banco, cobro, nro) {
  let op;
  try {
    op = await banco.verificarOperacion(nro);
  } catch (e) {
    if (e.desdeBanco && (e.estado === 404 || e.estado === 422)) {
      return rechazar(cobro, `El banco no reconoce la operación ${nro}.`);
    }
    throw e; // banco caído: el cobro queda como estaba y se vuelve a verificar después
  }
  if (op.cuentaDestino !== CUENTA_RUTALOG) return rechazar(cobro, `La operación ${nro} no fue un pago a RutaLog.`);
  if (op.tipo !== 'PAGO_QR') return rechazar(cobro, `La operación ${nro} no es un pago con QR.`);
  if (redondear(op.monto) !== redondear(cobro.monto)) {
    return rechazar(cobro, `La operación ${nro} es por S/ ${op.monto.toFixed(2)} y el cobro es por S/ ${Number(cobro.monto).toFixed(2)}.`);
  }
  return transaccion(async (bd) => {
    // Un mismo pago no puede confirmar dos cobros distintos.
    const usado = await bd.query('SELECT id FROM cobros WHERE nro_operacion_banco = $1 AND id <> $2', [op.nro, cobro.id]);
    if (usado.rows[0]) {
      const { rows } = await bd.query(
        "UPDATE cobros SET estado = 'RECHAZADO', motivo_rechazo = $1, nro_operacion_banco = NULL WHERE id = $2 RETURNING *",
        [`La operación ${op.nro} ya se usó para otro cobro.`, cobro.id]
      );
      return rows[0];
    }
    const { rows } = await bd.query(
      `UPDATE cobros SET estado = 'CONFIRMADO', nro_operacion_banco = $1, confirmado_en = NOW(), motivo_rechazo = NULL
       WHERE id = $2 AND estado IN ('POR_COBRAR', 'PENDIENTE_CONFIRMACION') RETURNING *`,
      [op.nro, cobro.id]
    );
    const actualizado = rows[0] || (await bd.query('SELECT * FROM cobros WHERE id = $1', [cobro.id])).rows[0];
    if (rows[0] && cobro.tipo === 'envio') {
      // RF-R02: con la confirmación del banco el envío queda pagado y ya se puede asignar al courier.
      await bd.query(
        "UPDATE envios SET pago_estado = 'PAGADO', version = version + 1, actualizado_en = NOW() WHERE id = $1 AND pago_estado = 'POR_PAGAR'",
        [cobro.envio_id]
      );
    }
    return actualizado;
  });
}

/**
 * Un cobro rechazado libera su número de operación (queda solo en el motivo): si el courier escribió un número
 * válido en el envío equivocado, ese pago todavía puede confirmar el cobro correcto.
 */
async function rechazar(cobro, motivo) {
  const { rows } = await consulta(
    `UPDATE cobros SET estado = 'RECHAZADO', motivo_rechazo = $1, nro_operacion_banco = NULL
     WHERE id = $2 AND estado IN ('POR_COBRAR', 'PENDIENTE_CONFIRMACION') RETURNING *`,
    [motivo, cobro.id]
  );
  return rows[0] || cobro;
}

/** Pregunta al banco por un cobro sin confirmar y lo actualiza si ya se pagó. */
async function verificarCobro(banco, cobro) {
  if (cobro.estado === 'PENDIENTE_CONFIRMACION' && cobro.nro_operacion_banco) {
    return confirmarConBanco(banco, cobro, cobro.nro_operacion_banco);
  }
  if (cobro.estado === 'POR_COBRAR' && cobro.cobro_banco_id) {
    const qr = await banco.consultarCobro(cobro.cobro_banco_id);
    if (qr.estado === 'PAGADO' && qr.nroOperacion) return confirmarConBanco(banco, cobro, qr.nroOperacion);
    return { ...cobro, vencido: qr.estado === 'VENCIDO' || qr.estado === 'ANULADO' };
  }
  return cobro;
}

/** Verifica todos los cobros pendientes que cumplan el filtro. Si el banco no responde, se deja para después. */
async function verificarPendientes(banco, filtroSql = 'TRUE', parametros = []) {
  const { rows } = await consulta(
    `SELECT c.* FROM cobros c JOIN envios e ON e.id = c.envio_id
     WHERE c.estado IN ('POR_COBRAR', 'PENDIENTE_CONFIRMACION') AND (${filtroSql}) ORDER BY c.creado_en LIMIT 100`,
    parametros
  );
  let verificados = 0;
  for (const cobro of rows) {
    try {
      const r = await verificarCobro(banco, cobro);
      if (r.estado !== cobro.estado) verificados += 1;
    } catch (e) {
      if (e.codigo === 'BANCO_NO_DISPONIBLE') break;
    }
  }
  return verificados;
}

/**
 * Cobro QR vigente (o uno nuevo) para un envío. Si ya está confirmado, se devuelve tal cual.
 * Se usa al pagar el envío, al cobrar el contraentrega y al armar la ruta del courier.
 */
async function obtenerOCrearCobro(banco, envio, tipo, creadoPor) {
  const monto = tipo === 'envio' ? Number(envio.costo_envio) : Number(envio.monto_contraentrega);
  if (!(monto > 0)) throw error(422, 'SIN_MONTO', tipo === 'envio' ? 'El envío no tiene costo.' : 'Este envío no es contraentrega.');

  const { rows } = await consulta(
    `SELECT * FROM cobros WHERE envio_id = $1 AND tipo = $2 AND estado <> 'RECHAZADO' ORDER BY creado_en DESC LIMIT 1`,
    [envio.id, tipo]
  );
  let cobro = rows[0];
  if (cobro && cobro.estado !== 'POR_COBRAR') return cobro; // confirmado, pendiente de confirmación o liquidado
  if (cobro) {
    cobro = await verificarCobro(banco, cobro);
    if (cobro.estado !== 'POR_COBRAR' || !cobro.vencido) return cobro;
  }

  const qr = await banco.crearCobroQr({
    monto,
    concepto: `${tipo === 'envio' ? 'Envío' : 'Contraentrega'} ${envio.numero_guia}`,
    referencia: `${tipo}:${envio.numero_guia}`,
    venceEnMin: tipo === 'envio' ? 60 : 24 * 60
  });
  const insertado = await consulta(
    `INSERT INTO cobros (id, envio_id, tipo, monto, estado, cobro_banco_id, codigo_qr)
     VALUES ($1, $2, $3, $4, 'POR_COBRAR', $5, $6) RETURNING *`,
    [crypto.randomUUID(), envio.id, tipo, monto, qr.id, qr.codigoQr]
  );
  void creadoPor;
  return insertado.rows[0];
}

const rutasPagos = express.Router();
rutasPagos.use(['/pagos', '/cobros', '/liquidaciones', '/credito', '/usuarios'], requiereSesion);

/**
 * POST /api/pagos/qr { envioId, tipo: 'envio' | 'contraentrega' } → cobro con codigoQr (BANCOANDINO:QR-...).
 * El remitente paga su envío; el courier muestra el QR del contraentrega en la puerta.
 */
rutasPagos.post('/pagos/qr', async (req, res, next) => {
  try {
    const tipo = req.body?.tipo === 'contraentrega' ? 'contraentrega' : req.body?.tipo === 'envio' ? 'envio' : null;
    if (!tipo) throw error(422, 'TIPO_INVALIDO', 'Indica si pagas el envío o cobras el contraentrega.');
    const envio = await envioPorId(req.body?.envioId);
    validarPermisoCobro(req, envio, tipo);
    if (tipo === 'envio' && envio.pago_estado === 'NO_REQUERIDO') {
      throw error(409, 'PAGO_NO_REQUERIDO', 'Este envío se registró antes de los pagos con QR: no requiere pago.');
    }
    if (tipo === 'contraentrega' && !['en_reparto', 'reprogramado'].includes(envio.estado)) {
      throw error(409, 'NO_EN_REPARTO', 'El contraentrega se cobra en la puerta, cuando el envío está en reparto.');
    }
    const cobro = await obtenerOCrearCobro(crearClienteBanco(req), envio, tipo, req.usuario.id);
    res.status(201).json(cobroAJson(cobro, envio));
  } catch (e) {
    next(e);
  }
});

/** GET /api/pagos/:id → estado del cobro; si sigue pendiente, se pregunta al banco en ese momento. */
rutasPagos.get('/pagos/:id', async (req, res, next) => {
  try {
    if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) throw error(400, 'ID_INVALIDO', 'Identificador de cobro inválido.');
    const { rows } = await consulta('SELECT * FROM cobros WHERE id = $1', [req.params.id]);
    if (!rows[0]) throw error(404, 'NO_ENCONTRADO', 'Ese cobro no existe.');
    const envio = await envioPorId(rows[0].envio_id);
    validarPermisoCobro(req, envio, rows[0].tipo);
    const cobro = await verificarCobro(crearClienteBanco(req), rows[0]);
    const actualizado = (await envioPorId(envio.id));
    res.json({ ...cobroAJson(cobro, envio), vencido: Boolean(cobro.vencido), pagoEstadoEnvio: actualizado.pago_estado });
  } catch (e) {
    next(e);
  }
});

/**
 * POST /api/envios/:id/cobro-offline (courier, RF-C06) — sin señal en la puerta.
 * Cuerpo: uuidOperacion, nroOperacion (lo muestra la app del banco del destinatario), comprobante (foto), fechaHora.
 * Queda PENDIENTE_CONFIRMACION y la API lo verifica con el banco al sincronizar.
 */
rutasPagos.post('/envios/:id/cobro-offline', requiereSesion, (req, res, next) => {
  ejecutarUnaVez(req, res, next, 'COBRO_OFFLINE', async (bd) => {
    if (!esCourier(req)) throw error(403, 'SIN_PERMISO', 'Solo el courier asignado registra el cobro.');
    const envio = await obtenerParaEditar(bd, req);
    if (!(Number(envio.monto_contraentrega) > 0)) throw error(422, 'SIN_MONTO', 'Este envío no es contraentrega.');
    const nro = String(req.body?.nroOperacion || '').trim().toUpperCase();
    if (!/^BA-\d{3,12}$/.test(nro)) {
      throw error(422, 'NRO_INVALIDO', 'Escribe el número de operación que muestra la app del banco (por ejemplo BA-44102).');
    }
    const comprobante = leerImagen(req.body?.comprobante, 'comprobante', { nombre: 'la foto del comprobante' });
    leerFechaEvento(req.body?.fechaHora, envio); // la hora del cobro no puede ser futura ni anterior al registro

    const { rows: previos } = await bd.query(
      "SELECT * FROM cobros WHERE envio_id = $1 AND tipo = 'contraentrega' AND estado IN ('PENDIENTE_CONFIRMACION', 'CONFIRMADO', 'LIQUIDADO')",
      [envio.id]
    );
    if (previos[0]) return { estado: 200, cuerpo: cobroAJson(previos[0], envio), idEnvio: envio.id };

    const fotoUrl = await guardarArchivo(bd, envio.id, 'comprobante', comprobante, req.usuario.id);
    const { rows } = await bd.query(
      `INSERT INTO cobros (id, envio_id, tipo, monto, estado, nro_operacion_banco, comprobante_url)
       VALUES ($1, $2, 'contraentrega', $3, 'PENDIENTE_CONFIRMACION', $4, $5)
       ON CONFLICT (nro_operacion_banco) DO NOTHING RETURNING *`,
      [crypto.randomUUID(), envio.id, envio.monto_contraentrega, nro, fotoUrl]
    );
    if (!rows[0]) throw error(409, 'NRO_USADO', `La operación ${nro} ya se registró para otro cobro.`);
    return { estado: 201, cuerpo: cobroAJson(rows[0], envio), idEnvio: envio.id };
  });
});

/** POST /api/pagos/verificar → verifica con el banco los cobros pendientes (los del courier o, para la operación, todos). */
rutasPagos.post('/pagos/verificar', async (req, res, next) => {
  try {
    const banco = crearClienteBanco(req);
    let verificados;
    if (esCourier(req)) verificados = await verificarPendientes(banco, 'e.courier_id = $1', [req.usuario.id]);
    else if (esCliente(req)) verificados = await verificarPendientes(banco, 'e.usuario_id = $1', [req.usuario.id]);
    else verificados = await verificarPendientes(banco);
    res.json({ verificados });
  } catch (e) {
    next(e);
  }
});

/** GET /api/cobros → RF-R04: los cobros contraentrega del remitente con su guía y número de operación. */
rutasPagos.get('/cobros', async (req, res, next) => {
  try {
    const propios = esCliente(req);
    if (!propios && !esOperacion(req)) throw error(403, 'SIN_PERMISO', 'Los cobros los ve el remitente o la operación.');
    const { rows } = await consulta(
      `SELECT c.*, e.numero_guia FROM cobros c JOIN envios e ON e.id = c.envio_id
       WHERE c.tipo = 'contraentrega' AND c.estado <> 'POR_COBRAR' ${propios ? 'AND e.usuario_id = $1' : ''}
       ORDER BY c.creado_en DESC LIMIT 200`,
      propios ? [req.usuario.id] : []
    );
    res.json({ datos: rows.map((c) => cobroAJson(c)) });
  } catch (e) {
    next(e);
  }
});

/** GET /api/usuarios/yo → perfil con la cuenta de Banco Andino donde recibe sus liquidaciones. */
rutasPagos.get('/usuarios/yo', async (req, res, next) => {
  try {
    const { rows } = await consulta('SELECT id, nombre, correo, rol, cuenta_banco FROM usuarios WHERE id = $1', [req.usuario.id]);
    res.json({ ...rows[0], cuentaBanco: rows[0].cuenta_banco, cuenta_banco: undefined });
  } catch (e) {
    next(e);
  }
});

/** PUT /api/usuarios/yo/cuenta-banco { cuenta } → se valida con el banco antes de guardarla. */
rutasPagos.put('/usuarios/yo/cuenta-banco', async (req, res, next) => {
  try {
    if (!esCliente(req)) throw error(403, 'SIN_PERMISO', 'Solo el remitente registra su cuenta para las liquidaciones.');
    const cuenta = String(req.body?.cuenta || '').trim();
    if (!/^\d{3}-\d{7}-\d$/.test(cuenta)) throw error(422, 'CUENTA_INVALIDA', 'La cuenta de Banco Andino tiene la forma 191-2604003-0.');
    const datos = await crearClienteBanco(req).consultarCuenta(cuenta);
    if (!datos.existe) throw error(404, 'CUENTA_NO_EXISTE', 'Esa cuenta no existe en Banco Andino.');
    await consulta('UPDATE usuarios SET cuenta_banco = $1 WHERE id = $2', [cuenta, req.usuario.id]);
    res.json({ cuentaBanco: cuenta, titular: datos.titular });
  } catch (e) {
    next(e);
  }
});

// ---------- Liquidaciones (RF-O03, RF-O04, RF-R05) ----------

function liquidacionAJson(l) {
  return {
    id: l.id,
    remitenteId: l.remitente_id,
    remitente: l.remitente ?? null,
    periodo: l.periodo,
    recaudado: Number(l.recaudado),
    costoEnvios: Number(l.costo_envios),
    neto: Number(l.neto),
    cobros: l.cobros_incluidos,
    estado: l.estado,
    cuentaDestino: l.cuenta_destino ?? l.cuenta_banco ?? null,
    nroOperacion: l.nro_operacion_banco,
    creadoEn: l.creado_en,
    transferidaEn: l.transferida_en
  };
}

/**
 * Lo que se le debe a cada remitente ahora: cobros CONFIRMADOS sin liquidar (RN-04) menos el costo de esos
 * envíos que no pagó por adelantado con QR. Es la vista previa del operador antes de calcular.
 */
async function pendientePorRemitente(bd) {
  const { rows } = await bd.query(
    `SELECT u.id AS remitente_id, u.nombre AS remitente, u.cuenta_banco,
            COUNT(c.id)::int AS cobros,
            COALESCE(SUM(c.monto), 0) AS recaudado,
            COALESCE(SUM(CASE WHEN e.pago_estado = 'PAGADO' THEN 0 ELSE e.costo_envio END), 0) AS costo_envios
     FROM cobros c JOIN envios e ON e.id = c.envio_id JOIN usuarios u ON u.id = e.usuario_id
     WHERE c.tipo = 'contraentrega' AND c.estado = 'CONFIRMADO' AND c.liquidacion_id IS NULL
     GROUP BY u.id, u.nombre, u.cuenta_banco ORDER BY u.nombre`
  );
  return rows.map((r) => ({
    remitenteId: r.remitente_id,
    remitente: r.remitente,
    cuentaBanco: r.cuenta_banco,
    cobros: r.cobros,
    recaudado: redondear(r.recaudado),
    costoEnvios: redondear(r.costo_envios),
    neto: redondear(r.recaudado - r.costo_envios)
  }));
}

/** GET /api/liquidaciones → operación: pendiente por remitente + historial. Remitente: solo las suyas. */
rutasPagos.get('/liquidaciones', async (req, res, next) => {
  try {
    if (esCliente(req)) {
      const { rows } = await consulta('SELECT * FROM liquidaciones WHERE remitente_id = $1 ORDER BY creado_en DESC', [req.usuario.id]);
      return res.json({ datos: rows.map(liquidacionAJson) });
    }
    if (!esOperacion(req)) throw error(403, 'SIN_PERMISO', 'Las liquidaciones las ve la operación.');
    const pendiente = await pendientePorRemitente({ query: consulta });
    const { rows } = await consulta(
      `SELECT l.*, u.nombre AS remitente, u.cuenta_banco FROM liquidaciones l JOIN usuarios u ON u.id = l.remitente_id
       ORDER BY l.creado_en DESC LIMIT 100`
    );
    res.json({ pendiente, datos: rows.map(liquidacionAJson) });
  } catch (e) {
    next(e);
  }
});

/**
 * Corte de liquidación: verifica con el banco los cobros pendientes y crea una liquidación CALCULADA por
 * remitente con lo confirmado hasta ahora. La usan el operador (botón) y el cron de martes y viernes.
 * Nunca transfiere: eso lo aprueba el administrador (RF-O04).
 */
async function calcularLiquidaciones(banco) {
  await verificarPendientes(banco);
  return transaccion(async (bd) => {
    await bd.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['liquidaciones']);
    const periodo = new Date().toISOString().slice(0, 16).replace('T', ' '); // corte con fecha y hora
    const resultado = [];
    for (const p of await pendientePorRemitente(bd)) {
      if (p.neto <= 0) continue; // sin saldo a favor no hay nada que transferir
      const { rows } = await bd.query(
        `INSERT INTO liquidaciones (remitente_id, periodo, recaudado, costo_envios, neto, cobros_incluidos, cuenta_destino)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [p.remitenteId, periodo, p.recaudado, p.costoEnvios, p.neto, p.cobros, p.cuentaBanco]
      );
      await bd.query(
        `UPDATE cobros c SET liquidacion_id = $1 FROM envios e
         WHERE e.id = c.envio_id AND e.usuario_id = $2 AND c.tipo = 'contraentrega' AND c.estado = 'CONFIRMADO' AND c.liquidacion_id IS NULL`,
        [rows[0].id, p.remitenteId]
      );
      resultado.push(liquidacionAJson({ ...rows[0], remitente: p.remitente }));
    }
    return resultado;
  });
}

/** POST /api/liquidaciones/calcular (operador o administrador) → corte manual. */
rutasPagos.post('/liquidaciones/calcular', async (req, res, next) => {
  try {
    if (!esOperacion(req)) throw error(403, 'SIN_PERMISO', 'Solo la operación calcula liquidaciones.');
    res.status(201).json({ datos: await calcularLiquidaciones(crearClienteBanco(req)) });
  } catch (e) {
    next(e);
  }
});

/** El cron de Vercel envía "Authorization: Bearer <CRON_SECRET>". Se compara en tiempo constante. */
function esLlamadaDelCron(req) {
  const secreto = process.env.CRON_SECRET;
  if (!secreto) throw error(503, 'CRON_NO_CONFIGURADO', 'Falta la variable CRON_SECRET en el servidor.');
  const esperado = Buffer.from(`Bearer ${secreto}`);
  const recibido = Buffer.from(req.get('authorization') || '');
  return recibido.length === esperado.length && crypto.timingSafeEqual(recibido, esperado);
}

/**
 * GET /api/cron/liquidaciones → corte automático de martes y viernes (RF-R05, HU-R03).
 * Lo llama Vercel según vercel.json ("crons"); deja las liquidaciones CALCULADAS para que el administrador
 * las revise y apruebe en la App Admin.
 */
rutasPagos.get('/cron/liquidaciones', async (req, res, next) => {
  try {
    if (!esLlamadaDelCron(req)) throw error(401, 'NO_AUTORIZADO', 'Solo el cron de Vercel puede llamar aquí.');
    const creadas = await calcularLiquidaciones(crearClienteBanco(req));
    console.log(`Cron de liquidaciones: ${creadas.length} calculadas`);
    res.json({ calculadas: creadas.length, datos: creadas });
  } catch (e) {
    next(e);
  }
});

/**
 * POST /api/liquidaciones/:id/aprobar (solo administrador, RF-O04) { uuidOperacion }
 * Ordena la transferencia en Banco Andino a la cuenta del remitente y marca sus cobros como LIQUIDADOS.
 */
rutasPagos.post('/liquidaciones/:id/aprobar', async (req, res, next) => {
  try {
    if (!esAdministrador(req)) throw error(403, 'SIN_PERMISO', 'Solo el administrador aprueba liquidaciones.');
    const id = Number(req.params.id);
    const uuid = String(req.body?.uuidOperacion || '').toLowerCase();
    if (!/^[0-9a-f-]{36}$/.test(uuid)) throw error(400, 'UUID_INVALIDO', 'Falta el identificador único de la operación.');
    const { rows } = await consulta(
      'SELECT l.*, u.nombre AS remitente, u.cuenta_banco FROM liquidaciones l JOIN usuarios u ON u.id = l.remitente_id WHERE l.id = $1',
      [id]
    );
    const liq = rows[0];
    if (!liq) throw error(404, 'NO_ENCONTRADO', 'Esa liquidación no existe.');
    if (liq.estado === 'TRANSFERIDA') return res.json(liquidacionAJson(liq));
    const cuenta = liq.cuenta_banco;
    if (!cuenta) throw error(409, 'SIN_CUENTA_BANCO', `${liq.remitente} todavía no registró su cuenta de Banco Andino.`);

    // El banco hace la transferencia (idempotente por uuid: si se reintenta, no paga dos veces).
    const lote = await crearClienteBanco(req).transferirLote({
      uuid,
      transferencias: [
        { cuentaDestino: cuenta, monto: Number(liq.neto), concepto: `Liquidación RutaLog ${liq.periodo}`, referencia: `LIQ-${liq.id}` }
      ]
    });
    const nro = lote.resultados[0].nroOperacion;
    const actualizada = await transaccion(async (bd) => {
      const { rows: r } = await bd.query(
        `UPDATE liquidaciones SET estado = 'TRANSFERIDA', nro_operacion_banco = $1, aprobada_por = $2, cuenta_destino = $3,
                transferida_en = NOW() WHERE id = $4 RETURNING *`,
        [nro, req.usuario.id, cuenta, liq.id]
      );
      await bd.query("UPDATE cobros SET estado = 'LIQUIDADO' WHERE liquidacion_id = $1 AND estado = 'CONFIRMADO'", [liq.id]);
      // El costo de los envíos que no se pagaron con QR se cobró al descontarlo de la liquidación.
      await bd.query(
        `UPDATE envios SET pago_estado = 'PAGADO', version = version + 1, actualizado_en = NOW()
         WHERE pago_estado = 'POR_PAGAR' AND id IN (SELECT envio_id FROM cobros WHERE liquidacion_id = $1)`,
        [liq.id]
      );
      return r[0];
    });
    res.json(liquidacionAJson({ ...actualizada, remitente: liq.remitente }));
  } catch (e) {
    next(e);
  }
});

// ---------- Mi crédito (RF-O06, RN-07, RN-08) ----------

/** Facturación de RutaLog por mes (solo totales: nunca datos de remitentes ni destinatarios). */
async function facturacionMensual(meses = 6) {
  const { rows } = await consulta(
    `SELECT to_char(date_trunc('month', creado_en), 'YYYY-MM') AS mes,
            SUM(costo_envio) AS facturacion, COUNT(*)::int AS envios
     FROM envios WHERE NOT eliminado AND creado_en >= date_trunc('month', NOW()) - make_interval(months => $1)
     GROUP BY 1 ORDER BY 1`,
    [meses - 1]
  );
  return rows.map((r) => ({ mes: r.mes, facturacion: redondear(r.facturacion), envios: r.envios }));
}

function soloAdministrador(req) {
  if (!esAdministrador(req)) throw error(403, 'SIN_PERMISO', 'Mi crédito es solo para el administrador.');
}

/** GET /api/credito/facturacion → lo que se compartiría con el banco si se autoriza. */
rutasPagos.get('/credito/facturacion', async (req, res, next) => {
  try {
    soloAdministrador(req);
    res.json({ datos: await facturacionMensual() });
  } catch (e) {
    next(e);
  }
});

function solicitudAJson(s, banco) {
  return {
    id: s.id,
    codigoBanco: s.codigo_banco,
    monto: Number(s.monto),
    plazoMeses: s.plazo_meses,
    proposito: s.proposito,
    estado: banco?.estado ?? s.estado,
    cuota: banco?.cuota ?? null,
    tasaAnual: banco?.tasaAnual ?? null,
    comentario: banco?.comentario ?? null,
    nroDesembolso: banco?.nroDesembolso ?? null,
    cronograma: banco?.cronograma ?? [],
    facturacion: s.facturacion_autorizada,
    creadoEn: s.creado_en
  };
}

/** POST /api/credito/solicitudes { monto, plazoMeses, proposito, autorizo: true } */
rutasPagos.post('/credito/solicitudes', async (req, res, next) => {
  try {
    soloAdministrador(req);
    if (req.body?.autorizo !== true) {
      throw error(422, 'SIN_AUTORIZACION', 'Autoriza compartir con el banco solo la facturación por mes y el número de envíos.');
    }
    const facturacion = await facturacionMensual();
    const credito = await crearClienteBanco(req).solicitarCredito({
      solicitante: 'RutaLog Perú SAC',
      monto: req.body?.monto,
      plazoMeses: req.body?.plazoMeses,
      proposito: String(req.body?.proposito || 'Furgoneta para reparto').slice(0, 200),
      facturacion
    });
    const { rows } = await consulta(
      `INSERT INTO solicitudes_credito (solicitante_id, monto, plazo_meses, proposito, facturacion_autorizada, estado, codigo_banco)
       VALUES ($1, $2, $3, $4, $5, 'EN_EVALUACION', $6) RETURNING *`,
      [req.usuario.id, credito.monto, credito.plazoMeses, credito.proposito, JSON.stringify(facturacion), credito.id]
    );
    res.status(201).json(solicitudAJson(rows[0], credito));
  } catch (e) {
    next(e);
  }
});

/** GET /api/credito/solicitudes → estado al día (se consulta al banco): evaluación, desembolso, cuota y cronograma. */
rutasPagos.get('/credito/solicitudes', async (req, res, next) => {
  try {
    soloAdministrador(req);
    const banco = crearClienteBanco(req);
    const { rows } = await consulta('SELECT * FROM solicitudes_credito ORDER BY creado_en DESC LIMIT 20');
    const datos = [];
    for (const s of rows) {
      let enBanco = null;
      if (s.codigo_banco) {
        try {
          enBanco = await banco.consultarCredito(s.codigo_banco);
          if (enBanco.estado !== s.estado) {
            await consulta('UPDATE solicitudes_credito SET estado = $1 WHERE id = $2', [enBanco.estado, s.id]);
          }
        } catch (e) {
          if (e.codigo !== 'BANCO_NO_DISPONIBLE') throw e;
        }
      }
      datos.push(solicitudAJson(s, enBanco));
    }
    res.json({ datos });
  } catch (e) {
    next(e);
  }
});

module.exports = { rutasPagos, obtenerOCrearCobro, verificarPendientes, cobroAJson, CUENTA_RUTALOG };
