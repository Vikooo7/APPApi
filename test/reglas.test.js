const test = require('node:test');
const assert = require('node:assert/strict');
const { validarCambioAdministrador, leerDestinatario } = require('../src/envios');
const { ENVIOS, ENVIOS_ADICIONALES, RUTAS, USUARIOS, COURIERS, ZONAS, generarGuia } = require('../src/esquema');

const TRANSPORTISTA = 'Carlos Quispe Mamani · AQP-482';

/** Fila de la tabla envios tal como la devuelve PostgreSQL. */
function envio(estado, transportista = null) {
  return {
    id: 1,
    uuid: '00000000-0000-4000-8000-000000000001',
    numero_guia: 'RLP-26-100001-2',
    ruta: 'Lima → Arequipa',
    peso_kg: '10.00',
    costo_envio: '29.00',
    estado,
    transportista_asignado: transportista,
    version: 1,
    actualizado_en: new Date()
  };
}

function rechaza(fn, estadoHttp, codigo) {
  assert.throws(fn, (e) => e.estado === estadoHttp && e.codigo === codigo);
}

test('el administrador puede avanzar el estado con transportista', () => {
  validarCambioAdministrador(envio('pendiente'), 'recogido', TRANSPORTISTA);
  validarCambioAdministrador(envio('recogido', TRANSPORTISTA), 'en_transito', TRANSPORTISTA);
  validarCambioAdministrador(envio('en_reparto', TRANSPORTISTA), 'entregado', TRANSPORTISTA);
});

test('puede asignar transportista sin cambiar el estado', () => {
  validarCambioAdministrador(envio('pendiente'), 'pendiente', TRANSPORTISTA);
});

test('sin transportista no pasa de pendiente (422)', () => {
  rechaza(() => validarCambioAdministrador(envio('pendiente'), 'recogido', null), 422, 'SIN_TRANSPORTISTA');
});

test('el estado no retrocede (409 con el envío real)', () => {
  const fila = envio('en_reparto', TRANSPORTISTA);
  assert.throws(
    () => validarCambioAdministrador(fila, 'en_transito', TRANSPORTISTA),
    (e) => e.estado === 409 && e.codigo === 'ESTADO_NO_RETROCEDE' && e.extra.envio.estado === 'en_reparto'
  );
});

test('un envío entregado queda cerrado (409)', () => {
  rechaza(
    () => validarCambioAdministrador(envio('entregado', TRANSPORTISTA), 'entregado', 'Otro · ABC-123'),
    409,
    'ENVIO_CERRADO'
  );
});

test('un estado que no existe se rechaza (422)', () => {
  rechaza(() => validarCambioAdministrador(envio('pendiente'), 'perdido', TRANSPORTISTA), 422, 'ESTADO_INVALIDO');
});

test('una entrega fallida se reprograma antes de cambiar el estado (409)', () => {
  rechaza(
    () => validarCambioAdministrador(envio('fallido', TRANSPORTISTA), 'en_reparto', TRANSPORTISTA),
    409,
    'ENTREGA_FALLIDA'
  );
});

test('en una entrega fallida o reprogramada se puede cambiar solo el courier', () => {
  validarCambioAdministrador(envio('fallido', TRANSPORTISTA), 'fallido', 'Otro · ABC-123');
  validarCambioAdministrador(envio('reprogramado', TRANSPORTISTA), 'reprogramado', 'Otro · ABC-123');
});

test('una entrega reprogramada vuelve a reparto pero no retrocede a recogido', () => {
  validarCambioAdministrador(envio('reprogramado', TRANSPORTISTA), 'en_reparto', TRANSPORTISTA);
  rechaza(
    () => validarCambioAdministrador(envio('reprogramado', TRANSPORTISTA), 'recogido', TRANSPORTISTA),
    409,
    'ESTADO_NO_RETROCEDE'
  );
});

test('el operador no marca fallido a mano ni cambia un envío devuelto', () => {
  rechaza(() => validarCambioAdministrador(envio('en_reparto', TRANSPORTISTA), 'fallido', TRANSPORTISTA), 422, 'ESTADO_INVALIDO');
  rechaza(() => validarCambioAdministrador(envio('devuelto', TRANSPORTISTA), 'devuelto', 'Otro · ABC-123'), 409, 'ENVIO_CERRADO');
});

test('el destinatario es opcional: la App Cliente del parcial sigue registrando', () => {
  assert.deepEqual(leerDestinatario({ ruta: 'Lima → Ica', pesoKg: 3 }), {
    nombre: null,
    telefono: null,
    direccion: null,
    monto: 0
  });
});

test('destinatario y contraentrega válidos', () => {
  const d = leerDestinatario({
    destinatarioNombre: '  Carlos Mendoza ',
    destinatarioTelefono: '987654321',
    destinatarioDireccion: 'Av. Huancavelica 512, El Tambo',
    montoContraentrega: 189.456
  });
  assert.equal(d.nombre, 'Carlos Mendoza');
  assert.equal(d.monto, 189.46);
});

test('reglas del destinatario y del monto (422)', () => {
  const base = { destinatarioNombre: 'Ana', destinatarioDireccion: 'Jr. Lima 120' };
  rechaza(() => leerDestinatario({ destinatarioNombre: 'Ana' }), 422, 'DESTINATARIO_INVALIDO');
  rechaza(() => leerDestinatario({ ...base, destinatarioTelefono: '12345' }), 422, 'TELEFONO_INVALIDO');
  rechaza(() => leerDestinatario({ ...base, montoContraentrega: -5 }), 422, 'MONTO_INVALIDO');
  rechaza(() => leerDestinatario({ ...base, montoContraentrega: 20000 }), 422, 'MONTO_INVALIDO');
  rechaza(() => leerDestinatario({ montoContraentrega: 50 }), 422, 'DESTINATARIO_INVALIDO');
});

test('al editar, lo que no llega se conserva', () => {
  const actual = {
    destinatario_nombre: 'Ana',
    destinatario_telefono: '912345678',
    destinatario_direccion: 'Jr. Lima 120',
    monto_contraentrega: '45.00'
  };
  assert.deepEqual(leerDestinatario({ pesoKg: 4 }, actual), {
    nombre: 'Ana',
    telefono: '912345678',
    direccion: 'Jr. Lima 120',
    monto: 45
  });
});

test('cada transportista de los datos de ejemplo es un courier registrado', () => {
  const etiquetas = new Set(COURIERS.map(([nombre, placa]) => `${nombre} · ${placa}`));
  const zonas = Object.keys(ZONAS);
  for (const [, , , , transportista] of [...ENVIOS, ...ENVIOS_ADICIONALES]) {
    if (transportista) assert.ok(etiquetas.has(transportista), `sin courier: ${transportista}`);
  }
  for (const [, , zona] of COURIERS) assert.ok(zonas.includes(zona), `zona desconocida: ${zona}`);
});

test('todas las rutas tienen una zona', () => {
  const regiones = new Set(Object.values(ZONAS).flat());
  for (const [nombre, , , region] of RUTAS) assert.ok(regiones.has(region), `sin zona: ${nombre}`);
});

test('los datos de ejemplo suman 40 envíos válidos', () => {
  const todos = [...ENVIOS, ...ENVIOS_ADICIONALES];
  assert.equal(ENVIOS_ADICIONALES.length, 30);
  assert.equal(todos.length, 40);

  const rutas = new Set(RUTAS.map((r) => r[0]));
  const clientes = new Set(USUARIOS.filter((u) => u[3] === 'cliente').map((u) => u[1]));
  const estados = ['pendiente', 'recogido', 'en_transito', 'en_reparto', 'entregado'];

  for (const [correo, ruta, peso, estado, transportista] of todos) {
    assert.ok(clientes.has(correo), `cliente desconocido: ${correo}`);
    assert.ok(rutas.has(ruta), `ruta desconocida: ${ruta}`);
    assert.ok(peso > 0, `peso inválido en ${ruta}`);
    assert.ok(estados.includes(estado), `estado inválido: ${estado}`);
    // La misma regla del servidor: fuera de pendiente, siempre hay transportista.
    assert.equal(estado === 'pendiente', transportista === null, `transportista incoherente en ${ruta} (${estado})`);
  }
});

test('las guías de los envíos adicionales son únicas y no chocan con las primeras', () => {
  const fecha = new Date(2026, 0, 1);
  const primeras = ENVIOS.map((_, i) => generarGuia(100001 + i, fecha));
  const adicionales = ENVIOS_ADICIONALES.map((_, i) => generarGuia(300001 + i, fecha));
  assert.equal(new Set([...primeras, ...adicionales]).size, 40);
  assert.equal(adicionales[0], 'RLP-26-300001-4');
});
