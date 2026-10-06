const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const express = require('express');
const { consulta, cadena } = require('./db');

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

    const perfil = { id: usuario.id, nombre: usuario.nombre, correo: usuario.correo, rol: usuario.rol };
    const token = jwt.sign(perfil, SECRETO, { expiresIn: DURACION_TOKEN });
    res.json({ token, usuario: perfil });
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

module.exports = { rutasAuth, requiereSesion, error };
