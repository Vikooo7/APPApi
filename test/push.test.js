const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const path = require('path');

// Base de datos falsa: dos celulares del remitente 7; se registran los DELETE.
const borrados = [];
require.cache[path.resolve(__dirname, '../src/db.js')] = {
  id: 'db', filename: 'db', loaded: true,
  exports: {
    consulta: async (sql, params) => {
      if (sql.startsWith('SELECT token')) return { rows: params[0] === 7 ? [{ token: 'token-vigente' }, { token: 'token-viejo' }] : [] };
      if (sql.startsWith('DELETE')) borrados.push(params[0]);
      return { rows: [] };
    },
    transaccion: async (fn) => fn({ query: async () => ({ rows: [] }) })
  }
};

// Cuenta de servicio de prueba (llave generada aquí, en base64 como en Vercel).
const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
process.env.FIREBASE_SERVICE_ACCOUNT = Buffer.from(JSON.stringify({
  project_id: 'rutalog-peru', client_email: 'push@rutalog-peru.iam.gserviceaccount.com',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }), token_uri: 'https://oauth2.googleapis.com/token'
})).toString('base64');

// Google falso: entrega el token de acceso y acepta un celular; el otro ya no existe (404).
const enviados = [];
global.fetch = async (url, opciones) => {
  if (url.includes('oauth2')) return { ok: true, status: 200, json: async () => ({ access_token: 'acceso-123', expires_in: 3600 }) };
  const cuerpo = JSON.parse(opciones.body);
  enviados.push({ url, autorizacion: opciones.headers.authorization, cuerpo });
  return cuerpo.message.token === 'token-vigente' ? { ok: true, status: 200 } : { ok: false, status: 404 };
};

const { avisoDeEstado, notificarUsuario, pushConfigurado, horaLima } = require('../src/push');

const envio = {
  numero_guia: 'RLP-26-345678-3', usuario_id: 7, ruta: 'Lima → Huancayo', destinatario_nombre: 'Carlos Mendoza'
};

test('un texto por cada acción del courier, con la hora de Lima', () => {
  assert.equal(horaLima('2026-11-19T15:32:00Z'), '10:32');
  const recogido = avisoDeEstado(envio, 'recogido', { fecha: '2026-11-19T15:32:00Z' });
  assert.equal(recogido.titulo, 'El courier recogió tu envío');
  assert.match(recogido.cuerpo, /RLP-26-345678-3 fue recogido a las 10:32\. Va camino a Huancayo/);
  assert.equal(recogido.usuarioId, 7);
  assert.deepEqual(recogido.datos, { tipo: 'estado', guia: 'RLP-26-345678-3', estado: 'recogido' });
  assert.match(avisoDeEstado(envio, 'en_reparto').cuerpo, /llega hoy a Carlos Mendoza/);
  assert.match(avisoDeEstado(envio, 'entregado', { recibeNombre: 'Ana Ruiz' }).cuerpo, /recibió Ana Ruiz/);
  assert.match(avisoDeEstado(envio, 'fallido', { motivo: 'ausente', intento: 2 }).cuerpo, /no había nadie.*intento 2 de 3/);
  assert.match(avisoDeEstado(envio, 'cobrado', { monto: 189, nroOperacion: 'BA-44120' }).cuerpo, /S\/ 189\.00.*BA-44120/);
  assert.equal(avisoDeEstado(envio, 'pendiente'), null);
});

test('envía a cada celular por FCM v1 y olvida los tokens que ya no existen', async () => {
  assert.equal(pushConfigurado(), true);
  const n = await notificarUsuario(avisoDeEstado(envio, 'en_reparto'));
  assert.equal(n, 1);
  assert.equal(enviados.length, 2);
  const m = enviados.find((e) => e.cuerpo.message.token === 'token-vigente');
  assert.equal(m.url, 'https://fcm.googleapis.com/v1/projects/rutalog-peru/messages:send');
  assert.equal(m.autorizacion, 'Bearer acceso-123');
  assert.equal(m.cuerpo.message.notification.title, 'Tu envío salió a reparto');
  assert.equal(m.cuerpo.message.android.priority, 'HIGH');
  assert.equal(m.cuerpo.message.android.notification.channel_id, 'envios_tiempo_real');
  assert.equal(m.cuerpo.message.android.notification.tag, 'RLP-26-345678-3');
  assert.equal(m.cuerpo.message.data.guia, 'RLP-26-345678-3'); // FCM exige que los datos sean texto
  assert.deepEqual(borrados, ['token-viejo']);
});

test('un usuario sin celulares registrados no envía nada', async () => {
  enviados.length = 0;
  assert.equal(await notificarUsuario({ ...avisoDeEstado(envio, 'recogido'), usuarioId: 99 }), 0);
  assert.equal(enviados.length, 0);
});
