// Celulares que reciben notificaciones push (Firebase Cloud Messaging). La app registra su token al iniciar
// sesión y lo borra al cerrarla; un token pertenece a un solo usuario (si otro inicia sesión en ese celular,
// pasa a ser suyo).
const express = require('express');
const { consulta } = require('./db');
const { error, requiereSesion } = require('./auth');
const { pushConfigurado } = require('./push');

const rutasDispositivos = express.Router();
const APPS = ['cliente', 'admin', 'courier'];

function leerToken(body) {
  const token = String(body?.token || '').trim();
  if (token.length < 20 || token.length > 4096 || /\s/.test(token)) {
    throw error(422, 'TOKEN_INVALIDO', 'El token de notificaciones no es válido.');
  }
  return token;
}

/** POST /api/dispositivos { token, app } → este celular recibe las notificaciones del usuario en esa app. */
rutasDispositivos.post('/dispositivos', requiereSesion, async (req, res, next) => {
  try {
    const token = leerToken(req.body);
    const app = String(req.body?.app || 'cliente');
    if (!APPS.includes(app)) throw error(422, 'APP_INVALIDA', 'La app debe ser cliente, admin o courier.');
    await consulta(
      `INSERT INTO dispositivos (token, usuario_id, app) VALUES ($1, $2, $3)
       ON CONFLICT (token) DO UPDATE SET usuario_id = EXCLUDED.usuario_id, app = EXCLUDED.app, actualizado_en = NOW()`,
      [token, req.usuario.id, app]
    );
    res.status(201).json({ registrado: true, pushActivo: pushConfigurado() });
  } catch (e) {
    next(e);
  }
});

/** DELETE /api/dispositivos { token } → al cerrar sesión, este celular deja de recibir avisos de ese usuario. */
rutasDispositivos.delete('/dispositivos', requiereSesion, async (req, res, next) => {
  try {
    const token = leerToken(req.body);
    await consulta('DELETE FROM dispositivos WHERE token = $1 AND usuario_id = $2', [token, req.usuario.id]);
    res.status(204).end();
  } catch (e) {
    next(e);
  }
});

module.exports = { rutasDispositivos };
