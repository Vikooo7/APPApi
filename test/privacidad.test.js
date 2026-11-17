const test = require('node:test');
const assert = require('node:assert/strict');
const { ocultarDestinatario } = require('../src/privacidad');
const { mensajeAvisoFallida } = require('../src/envios');

const envio = (estado) => ({
  numeroGuia: 'RLP-26-100001-1',
  estado,
  destinatarioNombre: 'Carlos Mendoza',
  destinatarioTelefono: '987654321',
  destinatarioDireccion: 'Av. Huancavelica 512',
  montoContraentrega: 189
});

test('el courier ve al destinatario solo en reparto o reprogramado', () => {
  for (const estado of ['en_reparto', 'reprogramado']) {
    assert.equal(ocultarDestinatario(envio(estado)).destinatarioTelefono, '987654321');
  }
  for (const estado of ['pendiente', 'recogido', 'en_transito', 'entregado', 'fallido', 'devuelto']) {
    const r = ocultarDestinatario(envio(estado));
    assert.equal(r.destinatarioNombre, null, estado);
    assert.equal(r.destinatarioTelefono, null, estado);
    assert.equal(r.destinatarioDireccion, null, estado);
    assert.equal(r.montoContraentrega, 189, 'el monto a cobrar sí se ve');
  }
});

test('filtra en cualquier nivel: ruta con paradas, enCamino y conflictos', () => {
  const ruta = {
    paradas: [{ tipo: 'recojo', envio: envio('pendiente') }, { tipo: 'entrega', envio: envio('en_reparto') }],
    enCamino: [envio('en_transito')],
    extra: { envio: envio('entregado') }
  };
  const r = ocultarDestinatario(ruta);
  assert.equal(r.paradas[0].envio.destinatarioNombre, null);
  assert.equal(r.paradas[1].envio.destinatarioNombre, 'Carlos Mendoza');
  assert.equal(r.enCamino[0].destinatarioDireccion, null);
  assert.equal(r.extra.envio.destinatarioTelefono, null);
  assert.equal(ruta.paradas[0].envio.destinatarioNombre, 'Carlos Mendoza', 'no modifica el original');
});

test('aviso de entrega fallida: SMS con celular enmascarado y texto para reprogramar', () => {
  const fila = { numero_guia: 'RLP-26-100001-1', destinatario_telefono: '987654321' };
  const aviso = mensajeAvisoFallida(fila, 'ausente', false);
  assert.equal(aviso.canal, 'sms');
  assert.equal(aviso.destino, '*****4321');
  assert.equal(aviso.motivo, 'entrega_fallida');
  assert.match(aviso.mensaje, /RLP-26-100001-1/);
  assert.match(aviso.mensaje, /reprogramar/);
  assert.ok(!aviso.mensaje.includes('987654321'));
});

test('al tercer intento el aviso dice que vuelve al remitente; sin celular no hay aviso', () => {
  const fila = { numero_guia: 'RLP-26-100001-1', destinatario_telefono: '987654321' };
  const aviso = mensajeAvisoFallida(fila, 'rechazado', true);
  assert.equal(aviso.motivo, 'devolucion');
  assert.match(aviso.mensaje, /vuelve al remitente/);
  assert.equal(mensajeAvisoFallida({ numero_guia: 'X', destinatario_telefono: null }, 'ausente', false), null);
});
