const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const express = require('express');
const { consulta, cadena } = require('./db');
const { verificarTokenFirebase, decidirIngresoSocial } = require('./firebase');

// Se recomienda definir JWT_SECRET en Vercel. Si falta, se deriva de la cadena de conexión,
// que también es secreta y solo existe en el servidor.
const SECRETO =
  process.env.JWT_SECRET ||
  crypto.createHash('sha256').update(`rutalog:${cadena || 'local'}`).digest('hex');

const DURACION_TOKEN = '30d';

function error(estado, codigo, mensaje) {
  const e = new Error(mensaje);
  e.estado = estado;
  e.codigo = codigo;
  return e;
}

const rutasAuth = express.Router();

const FORMATO_CORREO = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const CLAVE_MINIMA = 8;

/**
 * Valida los datos de una cuenta nueva. Devuelve { nombre, correo, clave } limpios
 * o lanza un error 422 con el motivo.
 */
function validarRegistro(cuerpo) {
  const nombre = String(cuerpo?.nombre || '').trim().replace(/\s+/g, ' ');
  const correo = String(cuerpo?.correo || '').trim().toLowerCase();
  const clave = String(cuerpo?.clave || '');
  if (!nombre || !correo || !clave) {
    throw error(422, 'DATOS_INCOMPLETOS', 'Completa tu nombre, tu correo y una contraseña.');
  }
  if (nombre.length < 3 || nombre.length > 80) {
    throw error(422, 'NOMBRE_INVALIDO', 'El nombre debe tener entre 3 y 80 caracteres.');
  }
  if (correo.length > 120 || !FORMATO_CORREO.test(correo)) {
    throw error(422, 'CORREO_INVALIDO', 'Ingresa un correo válido, por ejemplo nombre@gmail.com.');
  }
  if (clave.length < CLAVE_MINIMA || clave.length > 72) {
    throw error(422, 'CLAVE_DEBIL', `La contraseña debe tener al menos ${CLAVE_MINIMA} caracteres.`);
  }
  if (!/[A-Za-z]/.test(clave) || !/\d/.test(clave)) {
    throw error(422, 'CLAVE_DEBIL', 'La contraseña debe combinar letras y números.');
  }
  return { nombre, correo, clave };
}

function emitirSesion(usuario) {
  const perfil = { id: usuario.id, nombre: usuario.nombre, correo: usuario.correo, rol: usuario.rol };
  const token = jwt.sign(perfil, SECRETO, { expiresIn: DURACION_TOKEN });
  return { token, usuario: perfil };
}

/**
 * POST /api/auth/registro → 201 { token, usuario }
 * Solo crea cuentas de cliente: los couriers y operadores los registra la empresa.
 */
rutasAuth.post('/registro', async (req, res, next) => {
  try {
    const { nombre, correo, clave } = validarRegistro(req.body);
    const { rows } = await consulta(
      `INSERT INTO usuarios (nombre, correo, clave_hash, rol)
       VALUES ($1, $2, $3, 'cliente')
       ON CONFLICT (correo) DO NOTHING
       RETURNING id, nombre, correo, rol`,
      [nombre, correo, bcrypt.hashSync(clave, 10)]
    );
    if (!rows[0]) {
      throw error(409, 'CORREO_REGISTRADO', 'Ya existe una cuenta con ese correo. Inicia sesión.');
    }
    res.status(201).json(emitirSesion(rows[0]));
  } catch (e) {
    next(e);
  }
});

/**
 * POST /api/auth/social { idToken, app: 'cliente' | 'admin' | 'courier' } → { token, usuario }
 * La app inicia sesión con Google, Facebook o GitHub mediante Firebase y envía el ID token.
 * La API lo valida y entrega su propia sesión, igual que el login con correo.
 */
rutasAuth.post('/social', async (req, res, next) => {
  try {
    const app = String(req.body?.app || '');
    if (!['cliente', 'admin', 'courier'].includes(app)) {
      throw error(422, 'APP_INVALIDA', 'Indica desde qué app se inicia sesión.');
    }
    const perfil = await verificarTokenFirebase(req.body?.idToken);
    const { rows } = await consulta('SELECT * FROM usuarios WHERE correo = $1', [perfil.correo]);
    const decision = decidirIngresoSocial({ existente: rows[0], correoVerificado: perfil.correoVerificado, app });
    if (decision.accion === 'rechazar') throw decision.error;
    if (decision.accion === 'entrar') return res.json(emitirSesion(rows[0]));

    // Cuenta nueva de cliente: no tiene contraseña propia (se guarda un hash imposible de adivinar).
    const nombre = perfil.nombre.replace(/\s+/g, ' ').slice(0, 80);
    const claveAzar = bcrypt.hashSync(crypto.randomBytes(32).toString('hex'), 10);
    const creado = await consulta(
      `INSERT INTO usuarios (nombre, correo, clave_hash, rol)
       VALUES ($1, $2, $3, 'cliente')
       ON CONFLICT (correo) DO NOTHING
       RETURNING id, nombre, correo, rol`,
      [nombre, perfil.correo, claveAzar]
    );
    if (!creado.rows[0]) {
      throw error(409, 'CORREO_REGISTRADO', 'Ya existe una cuenta con ese correo. Vuelve a intentarlo.');
    }
    res.status(201).json(emitirSesion(creado.rows[0]));
  } catch (e) {
    next(e);
  }
});

/** POST /api/auth/login → { token, usuario } */
rutasAuth.post('/login', async (req, res, next) => {
  try {
    const correo = String(req.body?.correo || '').trim().toLowerCase();
    const clave = String(req.body?.clave || '');
    if (!correo || !clave) {
      throw error(400, 'DATOS_INCOMPLETOS', 'Ingresa tu correo y tu contraseña.');
    }

    const { rows } = await consulta('SELECT * FROM usuarios WHERE correo = $1', [correo]);
    const usuario = rows[0];
    if (!usuario) {
      throw error(401, 'USUARIO_NO_EXISTE', 'No existe una cuenta con ese correo.');
    }
    if (!bcrypt.compareSync(clave, usuario.clave_hash)) {
      throw error(401, 'CLAVE_INCORRECTA', 'La contraseña es incorrecta.');
    }

    res.json(emitirSesion(usuario));
  } catch (e) {
    next(e);
  }
});

/** Exige el encabezado Authorization: Bearer <token> y deja el perfil en req.usuario. */
function requiereSesion(req, res, next) {
  const encabezado = req.get('authorization') || '';
  const token = encabezado.startsWith('Bearer ') ? encabezado.slice(7) : null;
  if (!token) {
    return next(error(401, 'SIN_SESION', 'Inicia sesión para continuar.'));
  }
  try {
    req.usuario = jwt.verify(token, SECRETO);
    next();
  } catch (e) {
    next(error(401, 'SESION_VENCIDA', 'Tu sesión venció. Vuelve a iniciar sesión.'));
  }
}

module.exports = { rutasAuth, requiereSesion, error, validarRegistro };
