const express = require('express');
const { consulta } = require('./db');
const { error, requiereSesion } = require('./auth');
const {
  aJson,
  ejecutarUnaVez,
  esOperacion,
  resolverCourier,
  validarCapacidad,
  etiquetaCourier,
  ESTADOS_CERRADOS,
  MAX_INTENTOS
} = require('./envios');

const rutasOperacion = express.Router();

// Todo lo de este archivo es de la App Admin: operador o administrador.
function soloOperacion(req, res, next) {
  if (!esOperacion(req)) {
    return next(error(403, 'SIN_PERMISO', 'Solo el operador o el administrador pueden hacer esto.'));
  }
  next();
}

/** GET /api/couriers → couriers con su zona, capacidad y paradas activas (RF-O01). */
rutasOperacion.get('/couriers', requiereSesion, soloOperacion, async (req, res, next) => {
  try {
    const { rows } = await consulta(
      `SELECT u.id, u.nombre, u.correo, u.placa, u.zona, u.capacidad,
              COUNT(e.id) FILTER (WHERE e.estado <> ALL($1::text[]))::int AS activos
       FROM usuarios u
       LEFT JOIN envios e ON e.courier_id = u.id AND NOT e.eliminado
       WHERE u.rol = 'courier'
       GROUP BY u.id
       ORDER BY u.zona, u.nombre`,
      [ESTADOS_CERRADOS]
    );
    res.json({
      datos: rows.map((c) => ({
        id: c.id,
        nombre: c.nombre,
        correo: c.correo,
        placa: c.placa,
        etiqueta: etiquetaCourier(c),
        zona: c.zona,
        capacidad: c.capacidad,
        activos: c.activos,
        disponibles: Math.max(c.capacidad - c.activos, 0)
      }))
    });
  } catch (e) {
    next(e);
  }
});

/**
 * POST /api/asignaciones → asigna varios envíos a un courier en una sola operación (HU-O01).
 * Cuerpo: uuidOperacion, courierId, envioIds: [id, ...]. Todo o nada: si uno no se puede, no se asigna ninguno.
 */
rutasOperacion.post('/asignaciones', requiereSesion, soloOperacion, (req, res, next) => {
  ejecutarUnaVez(req, res, next, 'ASIGNAR', async (bd) => {
    const ids = Array.isArray(req.body?.envioIds) ? [...new Set(req.body.envioIds.map(Number))] : [];
    if (ids.length === 0 || ids.some((id) => !Number.isInteger(id))) {
      throw error(422, 'SIN_ENVIOS', 'Selecciona al menos un envío para asignar.');
    }
    const courier = await resolverCourier(bd, { courierId: req.body?.courierId });
    if (!courier) {
      throw error(422, 'COURIER_INVALIDO', 'Elige el courier que recibirá los envíos.');
    }

    const { rows: envios } = await bd.query(
      'SELECT * FROM envios WHERE id = ANY($1::int[]) AND NOT eliminado ORDER BY id FOR UPDATE',
      [ids]
    );
    if (envios.length !== ids.length) {
      throw error(404, 'NO_ENCONTRADO', 'Uno de los envíos ya no existe en el servidor. Sincroniza y vuelve a intentarlo.');
    }
    const cerrado = envios.find((e) => ESTADOS_CERRADOS.includes(e.estado));
    if (cerrado) {
      throw error(
        409,
        'ENVIO_CERRADO',
        `La guía ${cerrado.numero_guia} ya fue ${cerrado.estado === 'entregado' ? 'entregada' : 'devuelta'}: no se puede asignar.`
      );
    }

    const nuevos = envios.filter((e) => e.courier_id !== courier.id).map((e) => e.id);
    await validarCapacidad(bd, courier, nuevos);

    const { rows } = await bd.query(
      `UPDATE envios SET courier_id = $1, transportista_asignado = $2, version = version + 1, actualizado_en = NOW()
       WHERE id = ANY($3::int[]) RETURNING *`,
      [courier.id, etiquetaCourier(courier), nuevos]
    );
    const actualizados = new Map(rows.map((e) => [e.id, e]));

    return {
      estado: 200,
      cuerpo: {
        courierId: courier.id,
        asignados: nuevos.length,
        envios: envios.map((e) => aJson(actualizados.get(e.id) || e))
      }
    };
  });
});

/**
 * GET /api/fallidas → entregas fallidas con su historial de intentos (RF-C07 visto por el operador).
 * ?pendientes=1 devuelve solo las que esperan reprogramación.
 */
rutasOperacion.get('/fallidas', requiereSesion, soloOperacion, async (req, res, next) => {
  try {
    const estados = req.query.pendientes ? ['fallido'] : ['fallido', 'reprogramado', 'devuelto'];
    const { rows } = await consulta(
      `SELECT e.*, i.numero, i.motivo, i.foto_url, i.fecha, i.courier_id AS intento_courier_id, c.nombre AS courier_nombre
       FROM envios e
       JOIN intentos_fallidos i ON i.envio_id = e.id
       LEFT JOIN usuarios c ON c.id = i.courier_id
       WHERE NOT e.eliminado AND e.estado = ANY($1::text[])
       ORDER BY e.actualizado_en DESC, i.numero`,
      [estados]
    );

    const porEnvio = new Map();
    for (const fila of rows) {
      if (!porEnvio.has(fila.id)) {
        porEnvio.set(fila.id, { envio: aJson(fila), maxIntentos: MAX_INTENTOS, intentos: [] });
      }
      porEnvio.get(fila.id).intentos.push({
        numero: fila.numero,
        motivo: fila.motivo,
        fotoUrl: fila.foto_url,
        fecha: fila.fecha,
        courierId: fila.intento_courier_id,
        courierNombre: fila.courier_nombre
      });
    }
    res.json({ datos: [...porEnvio.values()] });
  } catch (e) {
    next(e);
  }
});

module.exports = { rutasOperacion };
