const test = require('node:test');
const assert = require('node:assert/strict');
const { validarCambioAdministrador } = require('../src/envios');
const { ENVIOS, ENVIOS_ADICIONALES, RUTAS, USUARIOS, generarGuia } = require('../src/esquema');

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
