const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { verificarTokenFirebase, decidirIngresoSocial } = require('../src/firebase');

// Un par de claves propio hace de "Google" para no depender de internet en las pruebas.
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const otro = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const PROYECTO = 'proyecto-prueba';
const opciones = { obtenerClaves: async () => ({ k1: publicKey }), proyecto: PROYECTO };

function firmar(datos, { clave = privateKey, kid = 'k1', aud = PROYECTO, expiresIn = '1h' } = {}) {
  return jwt.sign({ sub: 'uid-1', ...datos }, clave, {
    algorithm: 'RS256',
    keyid: kid,
    audience: aud,
    issuer: `https://securetoken.google.com/${aud}`,
    expiresIn
  });
}

const rechaza = (promesa, codigo) => assert.rejects(promesa, (e) => e.codigo === codigo);

test('un token válido de Google entrega correo verificado, nombre y proveedor', async () => {
  const token = firmar({ email: 'Ana@Gmail.com', email_verified: true, name: 'Ana Quispe', firebase: { sign_in_provider: 'google.com' } });
  assert.deepEqual(await verificarTokenFirebase(token, opciones), {
    correo: 'ana@gmail.com',
    correoVerificado: true,
    nombre: 'Ana Quispe',
    proveedor: 'google.com'
  });
});

test('sin nombre se usa la parte del correo; Facebook suele llegar sin verificar', async () => {
  const token = firmar({ email: 'luis@outlook.com', firebase: { sign_in_provider: 'facebook.com' } });
  const r = await verificarTokenFirebase(token, opciones);
  assert.equal(r.nombre, 'luis');
  assert.equal(r.correoVerificado, false);
});

test('se rechaza un token firmado por otro, de otro proyecto, vencido o basura (401)', async () => {
  await rechaza(verificarTokenFirebase(firmar({ email: 'a@b.pe' }, { clave: otro.privateKey }), opciones), 'TOKEN_SOCIAL_INVALIDO');
  await rechaza(verificarTokenFirebase(firmar({ email: 'a@b.pe' }, { aud: 'otro-proyecto' }), opciones), 'TOKEN_SOCIAL_INVALIDO');
  await rechaza(verificarTokenFirebase(firmar({ email: 'a@b.pe' }, { expiresIn: -10 }), opciones), 'TOKEN_SOCIAL_INVALIDO');
  await rechaza(verificarTokenFirebase(firmar({ email: 'a@b.pe' }, { kid: 'desconocida' }), opciones), 'TOKEN_SOCIAL_INVALIDO');
  await rechaza(verificarTokenFirebase('no-es-un-token', opciones), 'TOKEN_SOCIAL_INVALIDO');
  await rechaza(verificarTokenFirebase(undefined, opciones), 'TOKEN_SOCIAL_INVALIDO');
});

test('un token HS256 (firmado con secreto) no se acepta', async () => {
  const falso = jwt.sign({ sub: 'x', email: 'a@b.pe' }, 'secreto', { algorithm: 'HS256', keyid: 'k1', audience: PROYECTO });
  await rechaza(verificarTokenFirebase(falso, opciones), 'TOKEN_SOCIAL_INVALIDO');
});

test('una cuenta de GitHub sin correo público se rechaza (422)', async () => {
  await rechaza(verificarTokenFirebase(firmar({ firebase: { sign_in_provider: 'github.com' } }), opciones), 'SIN_CORREO');
});

test('cuenta existente: entra solo si el proveedor verificó el correo', () => {
  const existente = { id: 1, rol: 'courier' };
  assert.equal(decidirIngresoSocial({ existente, correoVerificado: true, app: 'courier' }).accion, 'entrar');
  const r = decidirIngresoSocial({ existente, correoVerificado: false, app: 'courier' });
  assert.equal(r.accion, 'rechazar');
  assert.equal(r.error.codigo, 'CORREO_NO_VERIFICADO');
});

test('sin cuenta: solo la App Cliente la crea; Admin y Courier responden 403', () => {
  assert.equal(decidirIngresoSocial({ existente: undefined, correoVerificado: false, app: 'cliente' }).accion, 'crear');
  for (const app of ['admin', 'courier']) {
    const r = decidirIngresoSocial({ existente: undefined, correoVerificado: true, app });
    assert.equal(r.error.estado, 403);
  }
});
