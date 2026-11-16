const crypto = require('crypto');
const jwt = require('jsonwebtoken');

// Proyecto de Firebase donde están activados Google, Facebook y GitHub (no es secreto).
const PROYECTO_FIREBASE = process.env.FIREBASE_PROJECT_ID || 'rutalog-peru';
const URL_CLAVES =
  'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';

function error(estado, codigo, mensaje) {
  const e = new Error(mensaje);
  e.estado = estado;
  e.codigo = codigo;
  return e;
}

let cache = { claves: null, vence: 0 };

/** Claves públicas con las que Google firma los ID token de Firebase (se guardan lo que indica max-age). */
async function clavesDeGoogle() {
  if (cache.claves && Date.now() < cache.vence) return cache.claves;
  const respuesta = await fetch(URL_CLAVES);
  if (!respuesta.ok) {
    throw error(503, 'PROVEEDOR_NO_DISPONIBLE', 'No se pudo validar el inicio con Google. Intenta de nuevo.');
  }
  const { keys } = await respuesta.json();
  const maxAge = /max-age=(\d+)/.exec(respuesta.headers.get('cache-control') || '');
  cache = {
    claves: Object.fromEntries(keys.map((k) => [k.kid, crypto.createPublicKey({ key: k, format: 'jwk' })])),
    vence: Date.now() + (maxAge ? Number(maxAge[1]) * 1000 : 60 * 60 * 1000)
  };
  return cache.claves;
}

/**
 * Comprueba que el ID token lo emitió Firebase para nuestro proyecto (firma RS256, aud, iss, vencimiento).
 * Devuelve { correo, correoVerificado, nombre, proveedor }.
 */
async function verificarTokenFirebase(idToken, { obtenerClaves = clavesDeGoogle, proyecto = PROYECTO_FIREBASE } = {}) {
  const invalido = () => error(401, 'TOKEN_SOCIAL_INVALIDO', 'No se pudo validar tu cuenta. Vuelve a intentarlo.');
  const decodificado = typeof idToken === 'string' ? jwt.decode(idToken, { complete: true }) : null;
  if (!decodificado || decodificado.header.alg !== 'RS256' || !decodificado.header.kid) throw invalido();

  const clave = (await obtenerClaves())[decodificado.header.kid];
  if (!clave) throw invalido();

  let datos;
  try {
    datos = jwt.verify(idToken, clave, {
      algorithms: ['RS256'],
      audience: proyecto,
      issuer: `https://securetoken.google.com/${proyecto}`
    });
  } catch (e) {
    throw invalido();
  }
  if (!datos.sub) throw invalido();

  const correo = String(datos.email || '').trim().toLowerCase();
  if (!correo) {
    throw error(422, 'SIN_CORREO', 'Tu cuenta no comparte un correo. Autoriza el correo o usa otra forma de ingreso.');
  }
  const proveedor = datos.firebase?.sign_in_provider || 'desconocido';
  return {
    correo,
    correoVerificado: datos.email_verified === true,
    nombre: String(datos.name || '').trim() || correo.split('@')[0],
    proveedor
  };
}

/**
 * Decide qué hacer con un ingreso por Google / Facebook / GitHub.
 * - Cuenta existente: se entra solo si el proveedor garantiza el correo (evita tomar cuentas ajenas).
 * - Sin cuenta: la App Cliente la crea como cliente; Admin y Courier no crean cuentas.
 */
function decidirIngresoSocial({ existente, correoVerificado, app }) {
  if (existente) {
    if (!correoVerificado) {
      return {
        accion: 'rechazar',
        error: error(409, 'CORREO_NO_VERIFICADO', 'Ya existe una cuenta con ese correo. Ingresa con tu correo y contraseña.')
      };
    }
    return { accion: 'entrar' };
  }
  if (app === 'cliente') return { accion: 'crear' };
  return {
    accion: 'rechazar',
    error: error(403, 'SIN_CUENTA', 'Tu correo no está registrado en RutaLog. Pide a la empresa que te cree la cuenta.')
  };
}

module.exports = { verificarTokenFirebase, decidirIngresoSocial, PROYECTO_FIREBASE };
