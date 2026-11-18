// Prueba de punta a punta de la fase de pagos con Banco Andino, contra una API local conectada a una COPIA de la base.
// Uso: node --env-file=.env servidor-local.js   (en otra terminal)
//      node pruebas/probar-pagos.js [http://localhost:3000/api]
// Mueve dinero simulado entre cuentas de prueba del banco. No ejecutar contra la base real.

const API = process.argv[2] || 'http://localhost:3000/api';
const BANCO = API.replace(/\/api$/, '') + '/banco/api';
let pasos = 0;
let fallos = 0;

async function pedir(base, metodo, ruta, token, cuerpo, extra = {}) {
  const respuesta = await fetch(base + ruta, {
    method: metodo,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra },
    body: cuerpo ? JSON.stringify(cuerpo) : undefined
  });
  const texto = await respuesta.text();
  let datos = null;
  try {
    datos = JSON.parse(texto);
  } catch (e) {
    datos = texto;
  }
  return { http: respuesta.status, datos };
}
const llamar = (...a) => pedir(API, ...a);
const banco = (...a) => pedir(BANCO, ...a);

function comprobar(descripcion, condicion, detalle) {
  pasos += 1;
  if (condicion) console.log(`  ✔ ${descripcion}`);
  else {
    fallos += 1;
    console.log(`  ✖ ${descripcion}`, detalle !== undefined ? JSON.stringify(detalle) : '');
  }
}

async function entrar(correo) {
  const r = await llamar('POST', '/auth/login', null, { correo, clave: '1234' });
  if (r.http !== 200) throw new Error(`No se pudo entrar como ${correo}: ${JSON.stringify(r.datos)}`);
  return r.datos.token;
}
async function entrarBanco(usuario) {
  const r = await banco('POST', '/clientes/login', null, { usuario, clave: 'banco2026' });
  if (r.http !== 200) throw new Error(`No se pudo entrar al banco como ${usuario}: ${JSON.stringify(r.datos)}`);
  return r.datos.token;
}
const saldo = async (token) => (await banco('GET', '/clientes/yo', token)).datos.cuentas[0].saldo;

const uuid = () => crypto.randomUUID();
const guiaNueva = () => `RLP-26-${String(Math.floor(600000 + Math.random() * 99999))}-0`;
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 1), Buffer.from([0xff, 0xd9])]).toString('base64');
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200, 2)]).toString('base64');
const gps = { latitud: -12.06, longitud: -77.04 };

(async () => {
  console.log(`API: ${API}\nBanco: ${BANCO}`);
  const cliente = await entrar('cliente@rutalog.pe');
  const supervisor = await entrar('supervisor@rutalog.pe'); // operador
  const admin = await entrar('operador@rutalog.pe'); // administrador
  const andina = await entrarBanco('andina'); // la billetera del remitente
  const carlos = await entrarBanco('cliente1'); // la billetera del destinatario (reto de la Semana 2)
  const lucia = await entrarBanco('lucia');

  console.log('Seguridad entre RutaLog y el banco');
  comprobar('sin la clave de servidor no se crea un cobro en el banco (401)', (await banco('POST', '/cobros-qr', null, { monto: 10, concepto: 'x' })).http === 401);
  comprobar('el token de RutaLog no sirve en la billetera del banco (401)', (await banco('GET', '/clientes/yo', cliente)).http === 401);
  comprobar('el token del banco no sirve en RutaLog (401)', (await llamar('GET', '/envios', andina)).http === 401);
  comprobar('clave del banco incorrecta (401)', (await banco('POST', '/clientes/login', null, { usuario: 'cliente1', clave: 'x' })).http === 401);

  console.log('El remitente paga su envío con QR (RF-R02)');
  const base = {
    ruta: 'Lima → Lima (urbano)',
    pesoKg: 2,
    destinatarioNombre: 'Carlos Mendoza',
    destinatarioTelefono: '987654321',
    destinatarioDireccion: 'Jr. Huallaga 120, Cercado'
  };
  const crear = async (monto) =>
    (await llamar('POST', '/envios', cliente, { ...base, uuidOperacion: uuid(), uuid: uuid(), numeroGuia: guiaNueva(), montoContraentrega: monto })).datos;
  const envio = await crear(189);
  comprobar('el envío nuevo queda POR_PAGAR', envio.pagoEstado === 'POR_PAGAR', envio);
  const couriers = (await llamar('GET', '/couriers', supervisor)).datos.datos;
  const courier = [...couriers].sort((a, b) => b.disponibles - a.disponibles)[0];
  const asignarSinPago = await llamar('POST', '/asignaciones', supervisor, { uuidOperacion: uuid(), courierId: courier.id, envioIds: [envio.id] });
  comprobar('sin pago no se asigna al courier (409)', asignarSinPago.http === 409 && asignarSinPago.datos.codigo === 'ENVIO_SIN_PAGO', asignarSinPago.datos);

  const qrEnvio = await llamar('POST', '/pagos/qr', cliente, { envioId: envio.id, tipo: 'envio' });
  comprobar('RutaLog pide al banco el QR por el costo exacto', qrEnvio.http === 201 && qrEnvio.datos.codigoQr?.startsWith('BANCOANDINO:QR-') && qrEnvio.datos.monto === envio.costoEnvio, qrEnvio.datos);
  const otraVez = await llamar('POST', '/pagos/qr', cliente, { envioId: envio.id, tipo: 'envio' });
  comprobar('pedirlo otra vez devuelve el mismo QR vigente', otraVez.datos.id === qrEnvio.datos.id);
  comprobar('otro rol no puede pagar el envío del remitente (403)', (await llamar('POST', '/pagos/qr', await entrar('cliente2@rutalog.pe'), { envioId: envio.id, tipo: 'envio' })).http === 403);

  const vista = await banco('GET', `/qr/${encodeURIComponent(qrEnvio.datos.codigoQr)}`, andina);
  comprobar('la billetera muestra comercio, monto y concepto antes de pagar', vista.datos.comercio === 'RutaLog Perú SAC' && vista.datos.monto === envio.costoEnvio, vista.datos);
  const saldoAntes = await saldo(andina);
  const idPago = uuid();
  const pago = await banco('POST', `/qr/${encodeURIComponent(qrEnvio.datos.codigoQr)}/pagar`, andina, { uuid: idPago });
  comprobar('el remitente paga con Banco Andino y recibe su número de operación', pago.http === 201 && /^BA-\d+$/.test(pago.datos.nroOperacion), pago.datos);
  const repetido = await banco('POST', `/qr/${encodeURIComponent(qrEnvio.datos.codigoQr)}/pagar`, andina, { uuid: idPago });
  comprobar('reenviar el mismo pago no cobra dos veces', repetido.datos.duplicado === true && (await saldo(andina)) === Math.round((saldoAntes - envio.costoEnvio) * 100) / 100);
  const segundo = await banco('POST', `/qr/${encodeURIComponent(qrEnvio.datos.codigoQr)}/pagar`, carlos, { uuid: uuid() });
  comprobar('un QR ya pagado no se paga otra vez (409)', segundo.http === 409 && segundo.datos.codigo === 'QR_PAGADO', segundo.datos);

  const estadoPago = await llamar('GET', `/pagos/${qrEnvio.datos.id}`, cliente);
  comprobar(
    'RutaLog verifica con el banco: CONFIRMADO y el envío queda PAGADO',
    estadoPago.datos.estado === 'CONFIRMADO' && estadoPago.datos.nroOperacion === pago.datos.nroOperacion && estadoPago.datos.pagoEstadoEnvio === 'PAGADO',
    estadoPago.datos
  );
  const asignado = await llamar('POST', '/asignaciones', supervisor, { uuidOperacion: uuid(), courierId: courier.id, envioIds: [envio.id] });
  comprobar('ya pagado, se asigna al courier', asignado.http === 200, asignado.datos);

  console.log('Cobro contraentrega en la puerta (RF-C05, RN-02)');
  const tokenCourier = await entrar(courier.correo);
  const avanzar = async (e) => {
    await llamar('POST', `/envios/${e.id}/eventos`, tokenCourier, { uuidOperacion: uuid(), estado: 'recogido', guia: e.numeroGuia, ...gps });
    await llamar('POST', `/envios/${e.id}/eventos`, tokenCourier, { uuidOperacion: uuid(), estado: 'en_transito', ...gps });
    await llamar('POST', `/envios/${e.id}/eventos`, tokenCourier, { uuidOperacion: uuid(), estado: 'en_reparto', ...gps });
  };
  await avanzar(envio);
  const ruta = await llamar('GET', '/courier/ruta', tokenCourier);
  const parada = ruta.datos.paradas.find((p) => p.envio.id === envio.id);
  comprobar(
    'la ruta trae el QR del contraentrega por el monto exacto (sirve aunque luego no haya señal)',
    parada?.tipo === 'entrega' && parada.cobro?.estado === 'POR_COBRAR' && parada.cobro.monto === 189 && parada.cobro.codigoQr,
    parada?.cobro
  );
  const evidencia = { foto: JPEG, firma: PNG, recibeNombre: 'Carlos Mendoza', recibeDni: '45124512', ...gps };
  const sinCobro = await llamar('POST', `/envios/${envio.id}/evidencia`, tokenCourier, { ...evidencia, uuidOperacion: uuid() });
  comprobar('sin cobro confirmado no se entrega (409)', sinCobro.http === 409 && sinCobro.datos.codigo === 'COBRO_PENDIENTE', sinCobro.datos);

  const saldoRutalogAntes = (await banco('GET', '/clientes/yo', await entrarBanco('rutalog'))).datos.cuentas[0].saldo;
  const pagoDestinatario = await banco('POST', `/qr/${encodeURIComponent(parada.cobro.codigoQr)}/pagar`, carlos, { uuid: uuid() });
  comprobar('el destinatario paga los S/ 189 con su app del banco', pagoDestinatario.http === 201, pagoDestinatario.datos);
  const verificado = await llamar('GET', `/pagos/${parada.cobro.id}`, tokenCourier);
  comprobar('el courier ve el cobro CONFIRMADO por el banco', verificado.datos.estado === 'CONFIRMADO', verificado.datos);
  const saldoRutalog = (await banco('GET', '/clientes/yo', await entrarBanco('rutalog'))).datos.cuentas[0].saldo;
  comprobar('el dinero entró a la cuenta de recaudo de RutaLog', Math.round((saldoRutalog - saldoRutalogAntes) * 100) === 18900);
  const entrega = await llamar('POST', `/envios/${envio.id}/evidencia`, tokenCourier, { ...evidencia, uuidOperacion: uuid() });
  comprobar('con el cobro confirmado se entrega', entrega.http === 201 && entrega.datos.estado === 'entregado', entrega.datos);

  console.log('Cobro sin señal: pendiente de confirmación (RF-C06)');
  const pagarEnvio = async (e) => {
    const qr = (await llamar('POST', '/pagos/qr', cliente, { envioId: e.id, tipo: 'envio' })).datos;
    await banco('POST', `/qr/${encodeURIComponent(qr.codigoQr)}/pagar`, andina, { uuid: uuid() });
    await llamar('GET', `/pagos/${qr.id}`, cliente);
  };
  const offline = await crear(95);
  const falso = await crear(60);
  for (const e of [offline, falso]) await pagarEnvio(e);
  await llamar('POST', '/asignaciones', supervisor, { uuidOperacion: uuid(), courierId: courier.id, envioIds: [offline.id, falso.id] });
  for (const e of [offline, falso]) await avanzar(e);
  const ruta2 = (await llamar('GET', '/courier/ruta', tokenCourier)).datos;
  const qrOffline = ruta2.paradas.find((p) => p.envio.id === offline.id).cobro;
  // El courier no tiene señal, pero el destinatario sí: paga con su app y le muestra el número de operación.
  const pagoLucia = await banco('POST', `/qr/${encodeURIComponent(qrOffline.codigoQr)}/pagar`, lucia, { uuid: uuid() });
  const conNro = await llamar('POST', `/envios/${offline.id}/cobro-offline`, tokenCourier, {
    uuidOperacion: uuid(),
    nroOperacion: pagoLucia.datos.nroOperacion,
    comprobante: JPEG,
    fechaHora: new Date().toISOString()
  });
  comprobar('el cobro queda PENDIENTE_CONFIRMACION con foto del comprobante', conNro.http === 201 && conNro.datos.estado === 'PENDIENTE_CONFIRMACION', conNro.datos);
  const entregaOffline = await llamar('POST', `/envios/${offline.id}/evidencia`, tokenCourier, { ...evidencia, uuidOperacion: uuid() });
  comprobar('con el cobro pendiente de confirmación se puede entregar (ficha, RF-C06)', entregaOffline.http === 201, entregaOffline.datos);
  const conNroAjeno = await llamar('POST', `/envios/${falso.id}/cobro-offline`, tokenCourier, {
    uuidOperacion: uuid(),
    nroOperacion: pago.datos.nroOperacion, // el pago del ENVÍO de otra guía: no es de este contraentrega
    comprobante: JPEG,
    fechaHora: new Date().toISOString()
  });
  comprobar('un número de operación ya usado por otro cobro se rechaza (409)', conNroAjeno.http === 409 && conNroAjeno.datos.codigo === 'NRO_USADO', conNroAjeno.datos);
  const conNroFalso = await llamar('POST', `/envios/${falso.id}/cobro-offline`, tokenCourier, {
    uuidOperacion: uuid(),
    nroOperacion: `BA-9${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`, // no existe en el banco
    comprobante: JPEG,
    fechaHora: new Date().toISOString()
  });
  comprobar('un número inventado se acepta como pendiente…', conNroFalso.http === 201 && conNroFalso.datos.estado === 'PENDIENTE_CONFIRMACION', conNroFalso.datos);
  const verif = await llamar('POST', '/pagos/verificar', tokenCourier);
  comprobar('…y al sincronizar el banco lo verifica', verif.http === 200 && verif.datos.verificados >= 2, verif.datos);
  const estadoOffline = await llamar('GET', `/pagos/${conNro.datos.id}`, tokenCourier);
  const estadoFalso = await llamar('GET', `/pagos/${conNroFalso.datos.id}`, tokenCourier);
  comprobar('el cobro real queda CONFIRMADO', estadoOffline.datos.estado === 'CONFIRMADO', estadoOffline.datos);
  comprobar('el inventado queda RECHAZADO con el motivo', estadoFalso.datos.estado === 'RECHAZADO' && /no reconoce/.test(estadoFalso.datos.motivoRechazo), estadoFalso.datos);

  console.log('Liquidación al remitente (RF-O03, RF-O04, RN-04)');
  const previa = await llamar('GET', '/liquidaciones', supervisor);
  const deAndina = previa.datos.pendiente.find((p) => p.remitente === 'Distribuidora Andina SAC');
  comprobar('la vista previa suma solo cobros confirmados (189 + 95), sin el rechazado', deAndina && deAndina.recaudado >= 284, deAndina);
  const calculo = await llamar('POST', '/liquidaciones/calcular', supervisor);
  const liq = calculo.datos.datos?.find((l) => l.remitente === 'Distribuidora Andina SAC');
  comprobar('el operador calcula la liquidación (recaudado − costo de envíos)', calculo.http === 201 && liq && liq.estado === 'CALCULADA' && liq.neto === Math.round((liq.recaudado - liq.costoEnvios) * 100) / 100, calculo.datos);
  const porOperador = await llamar('POST', `/liquidaciones/${liq.id}/aprobar`, supervisor, { uuidOperacion: uuid() });
  comprobar('el operador no puede aprobar: es del administrador (403)', porOperador.http === 403, porOperador.datos);
  const saldoAndina = await saldo(andina);
  const idAprobar = uuid();
  const aprobada = await llamar('POST', `/liquidaciones/${liq.id}/aprobar`, admin, { uuidOperacion: idAprobar });
  comprobar('el administrador aprueba y el banco transfiere', aprobada.http === 200 && aprobada.datos.estado === 'TRANSFERIDA' && /^BA-/.test(aprobada.datos.nroOperacion), aprobada.datos);
  comprobar('el neto llegó al céntimo a la cuenta del remitente (RNF-09)', Math.round(((await saldo(andina)) - saldoAndina) * 100) === Math.round(liq.neto * 100));
  const otraVezAprobar = await llamar('POST', `/liquidaciones/${liq.id}/aprobar`, admin, { uuidOperacion: idAprobar });
  comprobar('aprobar otra vez no transfiere dos veces', otraVezAprobar.datos.nroOperacion === aprobada.datos.nroOperacion && Math.round(((await saldo(andina)) - saldoAndina) * 100) === Math.round(liq.neto * 100));
  const misCobros = await llamar('GET', '/cobros', cliente);
  const cobro189 = misCobros.datos.datos.find((c) => c.numeroGuia === envio.numeroGuia);
  comprobar('el remitente ve su cobro con guía, n.º de operación y LIQUIDADO (RF-R04)', cobro189?.estado === 'LIQUIDADO' && cobro189.nroOperacion === pagoDestinatario.datos.nroOperacion, cobro189);
  const misLiq = await llamar('GET', '/liquidaciones', cliente);
  comprobar('y su liquidación transferida con el n.º de operación (RF-R05)', misLiq.datos.datos.some((l) => l.id === liq.id && l.estado === 'TRANSFERIDA'), misLiq.datos);
  comprobar('el remitente no ve las liquidaciones de otros', misLiq.datos.datos.every((l) => l.remitenteId === misLiq.datos.datos[0].remitenteId));
  console.log('Corte automático de martes y viernes (cron de Vercel)');
  // 401 si el servidor tiene CRON_SECRET; 503 si no lo tiene (tampoco calcula nada).
  const rechazado = async (token) => [401, 503].includes((await llamar('GET', '/cron/liquidaciones', token)).http);
  comprobar('sin el secreto del cron no se calcula nada', await rechazado(null));
  comprobar('con un secreto equivocado tampoco', await rechazado('otro-secreto'));
  comprobar('con un token de sesión de RutaLog tampoco', await rechazado(admin));
  if (process.env.CRON_SECRET) {
    const cron = await llamar('GET', '/cron/liquidaciones', process.env.CRON_SECRET);
    comprobar('el cron calcula y deja todo CALCULADO para el administrador', cron.http === 200 && cron.datos.datos.every((l) => l.estado === 'CALCULADA'), cron.datos);
  }

  const cuentaMala = await llamar('PUT', '/usuarios/yo/cuenta-banco', cliente, { cuenta: '191-0000000-0' });
  comprobar('una cuenta que no existe en el banco no se guarda (404)', cuentaMala.http === 404, cuentaMala.datos);

  console.log('Mi crédito (RF-O06, RN-07, RN-08)');
  comprobar('el operador no ve Mi crédito (403)', (await llamar('GET', '/credito/facturacion', supervisor)).http === 403);
  const fact = await llamar('GET', '/credito/facturacion', admin);
  comprobar('se comparte solo facturación y n.º de envíos por mes', fact.http === 200 && fact.datos.datos.every((m) => Object.keys(m).sort().join() === 'envios,facturacion,mes'), fact.datos);
  const sinAutorizar = await llamar('POST', '/credito/solicitudes', admin, { monto: 70000, plazoMeses: 48 });
  comprobar('sin autorización expresa no se envía nada al banco (422)', sinAutorizar.http === 422, sinAutorizar.datos);
  const solicitud = await llamar('POST', '/credito/solicitudes', admin, { monto: 70000, plazoMeses: 48, proposito: 'Furgoneta para reparto', autorizo: true });
  comprobar('la solicitud llega al banco EN_EVALUACION', solicitud.http === 201 && solicitud.datos.estado === 'EN_EVALUACION' && /^CR-/.test(solicitud.datos.codigoBanco), solicitud.datos);
  const web = await fetch(BANCO.replace('/api', '/comite'));
  comprobar('la web del comité responde', web.status === 200 && (await web.text()).includes('Comité de créditos'));
  comprobar('sin la clave del comité no se ve nada (401)', (await banco('GET', '/comite/creditos', null, undefined, { 'x-comite-clave': 'mala' })).http === 401);
  const decision = await banco('POST', `/comite/creditos/${solicitud.datos.codigoBanco}`, null, { decision: 'APROBADO', comentario: 'Facturación estable' }, { 'x-comite-clave': 'comite2026' });
  comprobar('el comité aprueba y el banco desembolsa', decision.http === 200 && decision.datos.estado === 'DESEMBOLSADO', decision.datos);
  const estadoCredito = await llamar('GET', '/credito/solicitudes', admin);
  const mio = estadoCredito.datos.datos.find((s) => s.codigoBanco === solicitud.datos.codigoBanco);
  comprobar('el administrador ve DESEMBOLSADO con cuota y cronograma de 48 meses', mio?.estado === 'DESEMBOLSADO' && mio.cuota > 0 && mio.cronograma.length === 48, mio && { estado: mio.estado, cuota: mio.cuota });

  console.log(`\n${pasos - fallos} de ${pasos} comprobaciones correctas.`);
  process.exit(fallos ? 1 : 0);
})().catch((e) => {
  console.error('La prueba se detuvo:', e.message);
  process.exit(1);
});
