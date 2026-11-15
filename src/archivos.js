const crypto = require('crypto');
const express = require('express');
const { consulta } = require('./db');
const { error, requiereSesion } = require('./auth');

/** Tamaño máximo por imagen ya comprimida por la app (RNF-07: se suben aunque la señal sea débil). */
const MAXIMO_BYTES = { foto_entrega: 400 * 1024, fachada: 400 * 1024, comprobante: 400 * 1024, firma: 150 * 1024 };

function tipoPorFirma(buffer) {
  if (buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.length > 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  return null;
}

/**
 * Lee una imagen enviada en base64 (con o sin el prefijo "data:image/...;base64,").
 * Solo acepta JPEG o PNG reales (se revisan los primeros bytes) y hasta el tamaño máximo del tipo.
 */
function leerImagen(valor, tipo, { obligatoria = true, nombre = 'la imagen' } = {}) {
  if (valor === undefined || valor === null || valor === '') {
    if (obligatoria) throw error(422, 'IMAGEN_REQUERIDA', `Falta ${nombre}.`);
    return null;
  }
  const texto = String(valor).replace(/^data:image\/[a-z]+;base64,/i, '');
  if (!/^[A-Za-z0-9+/=\s]+$/.test(texto)) {
    throw error(422, 'IMAGEN_INVALIDA', `${nombre[0].toUpperCase()}${nombre.slice(1)} no es una imagen válida.`);
  }
  const contenido = Buffer.from(texto, 'base64');
  const mime = tipoPorFirma(contenido);
  if (!mime) {
    throw error(422, 'IMAGEN_INVALIDA', `${nombre[0].toUpperCase()}${nombre.slice(1)} debe ser JPEG o PNG.`);
  }
  if (contenido.length > MAXIMO_BYTES[tipo]) {
    throw error(422, 'IMAGEN_MUY_GRANDE', `${nombre[0].toUpperCase()}${nombre.slice(1)} pesa demasiado: comprímela.`);
  }
  return { contenido, mime };
}

/** Guarda la imagen y devuelve la dirección con la que se descarga (/api/archivos/{id}). */
async function guardarArchivo(bd, envioId, tipo, imagen, usuarioId) {
  const id = crypto.randomUUID();
  await bd.query(
    `INSERT INTO archivos (id, envio_id, tipo, mime, contenido, bytes, creado_por)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [id, envioId, tipo, imagen.mime, imagen.contenido, imagen.contenido.length, usuarioId]
  );
  return `/api/archivos/${id}`;
}

const rutasArchivos = express.Router();

/**
 * GET /api/archivos/:id → la imagen. Solo la ve quien puede ver el envío: el cliente dueño,
 * el courier asignado o la operación (ética del caso: datos mínimos por rol).
 */
rutasArchivos.get('/archivos/:id', requiereSesion, async (req, res, next) => {
  try {
    if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) {
      throw error(404, 'NO_ENCONTRADO', 'La imagen no existe.');
    }
    const { rows } = await consulta(
      `SELECT a.mime, a.contenido, e.usuario_id, e.courier_id
       FROM archivos a JOIN envios e ON e.id = a.envio_id WHERE a.id = $1`,
      [req.params.id]
    );
    const archivo = rows[0];
    if (!archivo) {
      throw error(404, 'NO_ENCONTRADO', 'La imagen no existe.');
    }
    const { rol, id } = req.usuario;
    const puede =
      rol === 'operador' ||
      rol === 'administrador' ||
      (rol === 'courier' && archivo.courier_id === id) ||
      (rol === 'cliente' && archivo.usuario_id === id);
    if (!puede) {
      throw error(403, 'SIN_PERMISO', 'No tienes permiso para ver esta imagen.');
    }
    res.set('Content-Type', archivo.mime);
    res.set('Cache-Control', 'private, max-age=86400');
    res.send(archivo.contenido);
  } catch (e) {
    next(e);
  }
});

module.exports = { leerImagen, guardarArchivo, rutasArchivos };
