const express = require('express');
const { consulta } = require('./db');
const { asegurarEsquema } = require('./esquema');
const { rutasAuth, requiereSesion, error } = require('./auth');
const { rutasEnvios } = require('./envios');

const app = express();
app.use(express.json({ limit: '100kb' }));

// Para la prueba "simular error del servidor": la app envía este encabezado desde la pantalla
// de sincronización y la API responde 503 sin tocar la base de datos.
app.use((req, res, next) => {
  if (req.get('x-simular-error')) {
    return res.status(503).json({
      codigo: 'SERVIDOR_NO_DISPONIBLE',
      mensaje: 'Error del servidor simulado para la prueba.'
    });
  }
  next();
});

app.get(['/', '/api', '/api/health'], (req, res) => {
  res.json({ servicio: 'RutaLog Perú API', estado: 'activo', hora: new Date().toISOString() });
});

// Crea las tablas y los datos de ejemplo la primera vez que alguien usa la API.
app.use('/api', async (req, res, next) => {
  try {
    await asegurarEsquema();
    next();
  } catch (e) {
    next(e);
  }
});

app.use('/api/auth', rutasAuth);
app.use('/api/envios', requiereSesion, rutasEnvios);

/** GET /api/rutas → rutas activas con su tiempo estimado y su tarifa por kg. */
app.get('/api/rutas', requiereSesion, async (req, res, next) => {
  try {
    const { rows } = await consulta('SELECT * FROM rutas WHERE activa ORDER BY id');
    res.json({
      datos: rows.map((r) => ({
        id: r.id,
        nombre: r.nombre,
        tiempoEstimado: r.tiempo_estimado,
        tarifaPorKg: Number(r.tarifa_por_kg),
        region: r.region
      }))
    });
  } catch (e) {
    next(e);
  }
});

app.use((req, res, next) => {
  next(error(404, 'RUTA_NO_ENCONTRADA', `No existe ${req.method} ${req.path}`));
});

// Todas las respuestas de error tienen la misma forma: { codigo, mensaje, ...extra }
// eslint-disable-next-line no-unused-vars
app.use((e, req, res, next) => {
  if (e.type === 'entity.parse.failed') {
    return res.status(400).json({ codigo: 'JSON_INVALIDO', mensaje: 'El cuerpo de la petición no es JSON válido.' });
  }
  const estado = e.estado || 500;
  if (estado >= 500) {
    console.error(e);
  }
  res.status(estado).json({
    codigo: e.codigo || 'ERROR_INTERNO',
    mensaje: estado >= 500 && !e.codigo ? 'Ocurrió un error en el servidor.' : e.message,
    ...(e.extra || {})
  });
});

module.exports = app;
