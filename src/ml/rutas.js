// ML-01 en la App Admin (RF-O02, HU-O01): riesgo de cada entrega y aviso previo al destinatario.
const express = require('express');
const { consulta } = require('../db');
const { error, requiereSesion } = require('../auth');
const { aJson, ejecutarUnaVez, esOperacion, obtenerParaEditar, conflicto, ETIQUETAS, ESTADOS_CERRADOS } = require('../envios');
const { evaluar, franjaPorOrden, infoModelo } = require('./riesgo');
const { pronosticarVolumen } = require('./pronosticos');

const rutasMl = express.Router();

function soloOperacion(req, res, next) {
  if (!esOperacion(req)) return next(error(403, 'SIN_PERMISO', 'El riesgo de entregas lo ve la operación.'));
  next();
}

/** Día de entrega: ?fecha=AAAA-MM-DD o, si no viene, mañana en Lima (UTC−5). */
function leerFecha(valor) {
  if (valor === undefined || valor === '') {
    const manana = new Date(Date.now() - 5 * 3600 * 1000 + 24 * 3600 * 1000);
    return new Date(Date.UTC(manana.getUTCFullYear(), manana.getUTCMonth(), manana.getUTCDate()));
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(valor)) || Number.isNaN(new Date(`${valor}T00:00:00Z`).getTime())) {
    throw error(422, 'FECHA_INVALIDA', 'La fecha debe tener el formato AAAA-MM-DD.');
  }
  return new Date(`${valor}T00:00:00Z`);
}

// Entregas que todavía no se cierran: las que se recogerán, las que van en camino y las que están por entregarse.
const ESTADOS_POR_ENTREGAR = ['pendiente', 'recogido', 'en_transito', 'en_reparto', 'reprogramado', 'fallido'];

/**
 * GET /api/ml/riesgo-fallida?fecha=AAAA-MM-DD → probabilidad de falla de cada entrega (ML-01),
 * de mayor a menor, con los factores que más la suben y si ya se pidió la confirmación del horario.
 */
rutasMl.get('/ml/riesgo-fallida', requiereSesion, soloOperacion, async (req, res, next) => {
  try {
    const fecha = leerFecha(req.query.fecha);
    const { rows } = await consulta(
      `SELECT e.*, r.zona, c.nombre AS courier_nombre,
              (SELECT COUNT(*) FROM envios x
                WHERE e.courier_id IS NOT NULL AND x.courier_id = e.courier_id AND NOT x.eliminado
                  AND x.estado <> ALL($2::text[]))::int AS carga_courier,
              (SELECT COUNT(*) FROM intentos_fallidos i JOIN envios o ON o.id = i.envio_id
                WHERE o.destinatario_telefono = e.destinatario_telefono AND o.id <> e.id)::int AS fallas_destinatario,
              (SELECT p.orden FROM paradas p WHERE p.envio_id = e.id AND p.tipo = 'entrega'
                ORDER BY p.fecha DESC LIMIT 1) AS orden_parada
       FROM envios e
       LEFT JOIN rutas r ON r.nombre = e.ruta
       LEFT JOIN usuarios c ON c.id = e.courier_id
       WHERE NOT e.eliminado AND e.estado = ANY($1::text[])
       ORDER BY e.id`,
      [ESTADOS_POR_ENTREGAR, ESTADOS_CERRADOS]
    );

    const datos = rows
      .map((e) => {
        const franja = franjaPorOrden(e.orden_parada);
        const resultado = evaluar({
          montoContraentrega: Number(e.monto_contraentrega),
          intentos: e.intentos,
          fallasDestinatario: e.fallas_destinatario,
          confirmado: e.confirmacion_estado === 'CONFIRMADA',
          cargaCourier: e.carga_courier,
          franja,
          zona: e.zona,
          fecha
        });
        return {
          envio: aJson(e),
          zona: e.zona ?? null,
          courier: e.courier_nombre ?? null,
          franja,
          ...resultado,
          confirmacion: {
            estado: e.confirmacion_estado ?? null,
            pedidaEn: e.confirmacion_pedida_en ?? null,
            confirmadaEn: e.confirmado_en ?? null,
            sinTelefono: !e.destinatario_telefono
          }
        };
      })
      .sort((a, b) => b.probabilidad - a.probabilidad);

    res.json({
      fecha: fecha.toISOString().slice(0, 10),
      modelo: infoModelo(),
      resumen: {
        entregas: datos.length,
        riesgoAlto: datos.filter((d) => d.riesgoAlto).length,
        confirmacionPedida: datos.filter((d) => d.riesgoAlto && d.confirmacion.estado).length
      },
      datos
    });
  } catch (e) {
    next(e);
  }
});

/**
 * GET /api/ml/pronostico-volumen?fecha=AAAA-MM-DD (operación) → ML-03: envíos esperados por zona ese día
 * (por defecto mañana), cuántos couriers programar y cuántos hay registrados en cada zona.
 */
rutasMl.get('/ml/pronostico-volumen', requiereSesion, soloOperacion, async (req, res, next) => {
  try {
    const pronostico = pronosticarVolumen(leerFecha(req.query.fecha));
    const { rows } = await consulta("SELECT zona, COUNT(*)::int AS couriers FROM usuarios WHERE rol = 'courier' GROUP BY zona");
    const disponibles = new Map(rows.map((r) => [r.zona, r.couriers]));
    res.json({
      ...pronostico,
      zonas: pronostico.zonas.map((z) => ({ ...z, couriersRegistrados: disponibles.get(z.zona) || 0 }))
    });
  } catch (e) {
    next(e);
  }
});

/** Mensaje (SMS simulado) que pide al destinatario confirmar que habrá alguien para recibir. */
function mensajeConfirmacion(envio) {
  return (
    `RutaLog: pronto entregaremos tu envío ${envio.numero_guia}. ` +
    'Responde 1 si habrá alguien para recibirlo o 2 para elegir otro horario.'
  );
}

/** "*****4321": el operador no necesita ver el celular completo. */
const enmascarar = (t) => {
  const d = String(t || '').replace(/\D/g, '');
  return d.length >= 4 ? `*****${d.slice(-4)}` : '*****';
};

function validarActivo(envio) {
  if (!ESTADOS_POR_ENTREGAR.includes(envio.estado)) {
    throw conflicto('ESTADO_NO_PERMITE', `El envío ya está ${ETIQUETAS[envio.estado]}: no hay entrega que confirmar.`, envio);
  }
}

const confirmacionAJson = (e) => ({
  envioId: e.id,
  numeroGuia: e.numero_guia,
  estado: e.confirmacion_estado,
  pedidaEn: e.confirmacion_pedida_en,
  confirmadaEn: e.confirmado_en
});

/**
 * POST /api/envios/:id/confirmacion { uuidOperacion } (operación) → envía al destinatario el SMS (simulado)
 * que pide confirmar el horario. Queda en los avisos del envío, como los de entrega fallida.
 */
rutasMl.post('/envios/:id/confirmacion', requiereSesion, soloOperacion, (req, res, next) => {
  ejecutarUnaVez(req, res, next, 'PEDIR_CONFIRMACION', async (bd) => {
    const envio = await obtenerParaEditar(bd, req);
    validarActivo(envio);
    if (!envio.destinatario_telefono) {
      throw error(422, 'SIN_TELEFONO', 'El envío no tiene celular del destinatario: no se le puede avisar.');
    }
    const mensaje = mensajeConfirmacion(envio);
    const destino = enmascarar(envio.destinatario_telefono);
    await bd.query(
      "INSERT INTO avisos (envio_id, motivo, canal, destino, mensaje) VALUES ($1, 'confirmacion', 'sms', $2, $3)",
      [envio.id, destino, mensaje]
    );
    const { rows } = await bd.query(
      `UPDATE envios SET confirmacion_estado = 'PEDIDA', confirmacion_pedida_en = NOW(), confirmado_en = NULL
       WHERE id = $1 RETURNING *`,
      [envio.id]
    );
    return { estado: 201, cuerpo: { ...confirmacionAJson(rows[0]), aviso: { canal: 'sms', destino, mensaje } }, idEnvio: envio.id };
  });
});

/**
 * POST /api/envios/:id/confirmacion/confirmar { uuidOperacion } (operación) → registra que el destinatario
 * respondió "1": habrá alguien. La confirmación es la variable que más baja el riesgo en ML-01.
 */
rutasMl.post('/envios/:id/confirmacion/confirmar', requiereSesion, soloOperacion, (req, res, next) => {
  ejecutarUnaVez(req, res, next, 'CONFIRMAR_HORARIO', async (bd) => {
    const envio = await obtenerParaEditar(bd, req);
    validarActivo(envio);
    if (!envio.confirmacion_estado) {
      throw error(409, 'SIN_SOLICITUD', 'Primero pide la confirmación al destinatario.');
    }
    const { rows } = await bd.query(
      "UPDATE envios SET confirmacion_estado = 'CONFIRMADA', confirmado_en = NOW() WHERE id = $1 RETURNING *",
      [envio.id]
    );
    return { estado: 200, cuerpo: confirmacionAJson(rows[0]), idEnvio: envio.id };
  });
});

module.exports = { rutasMl, leerFecha };
