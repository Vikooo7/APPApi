const express = require('express');
const { transaccion, consulta } = require('./db');
const { crearClienteBanco } = require('./clienteBanco');
const { error, requiereSesion } = require('./auth');
const { leerImagen, guardarArchivo } = require('./archivos');
const { baseDeZona, distanciaKm, ordenarParadas, longitudRecorrido } = require('./rutas-optimas');
const {
  aJson,
  ejecutarUnaVez,
  obtenerParaEditar,
  conflicto,
  registrarEvento,
  leerFechaEvento,
  leerUbicacion,
  ETIQUETAS
} = require('./envios');

const rutasCourier = express.Router();

function soloCourier(req, res, next) {
  if (req.usuario.rol !== 'courier') {
    return next(error(403, 'SIN_PERMISO', 'Esta acción es de la App Courier.'));
  }
  next();
}

const conSesionDeCourier = [requiereSesion, soloCourier];

/** Pendiente → recojo en el origen; en reparto o reprogramado → entrega en el destino. */
function paradaDe(envio) {
  if (envio.estado === 'pendiente') {
    return { tipo: 'recojo', latitud: Number(envio.origen_latitud), longitud: Number(envio.origen_longitud) };
  }
  if (envio.estado === 'en_reparto' || envio.estado === 'reprogramado') {
    return { tipo: 'entrega', latitud: Number(envio.destino_latitud), longitud: Number(envio.destino_longitud) };
  }
  return null;
}

const clave = (p) => `${p.envioId}:${p.tipo}`;

/**
 * Ruta del día del courier (RF-C01). Ordena las paradas con ML-04; si el courier ya las reordenó
 * a mano hoy y siguen siendo las mismas, respeta su orden (RF-C02). El orden se guarda en "paradas".
 */
async function construirRuta(bd, courier, inicio) {
  const { rows: envios } = await bd.query(
    `SELECT * FROM envios
     WHERE courier_id = $1 AND NOT eliminado
       AND estado IN ('pendiente', 'recogido', 'en_transito', 'en_reparto', 'reprogramado')
     ORDER BY id`,
    [courier.id]
  );
  const porId = new Map(envios.map((e) => [e.id, e]));

  // Orden de registro: el de los envíos tal como se registraron (la métrica de la ficha compara contra este).
  const candidatas = envios
    .map((e) => ({ envioId: e.id, ...paradaDe(e) }))
    .filter((p) => p.tipo && Number.isFinite(p.latitud) && Number.isFinite(p.longitud));

  const { rows: guardadas } = await bd.query(
    'SELECT envio_id, tipo, orden, manual FROM paradas WHERE courier_id = $1 AND fecha = CURRENT_DATE ORDER BY orden',
    [courier.id]
  );
  const mismasParadas =
    guardadas.length === candidatas.length &&
    guardadas.every((g) => candidatas.some((c) => c.envioId === g.envio_id && c.tipo === g.tipo));
  const manual = mismasParadas && guardadas.some((g) => g.manual);

  let ordenadas;
  const resumen = ordenarParadas(inicio, candidatas);
  if (manual) {
    const porClave = new Map(candidatas.map((c) => [clave(c), c]));
    ordenadas = guardadas.map((g) => porClave.get(`${g.envio_id}:${g.tipo}`));
  } else {
    ordenadas = resumen.paradas;
    await bd.query('DELETE FROM paradas WHERE courier_id = $1 AND fecha = CURRENT_DATE', [courier.id]);
    let orden = 0;
    for (const p of ordenadas) {
      orden += 1;
      await bd.query(
        `INSERT INTO paradas (courier_id, envio_id, tipo, orden, latitud, longitud, manual)
         VALUES ($1, $2, $3, $4, $5, $6, FALSE)
         ON CONFLICT (envio_id, tipo, fecha) DO UPDATE SET courier_id = EXCLUDED.courier_id, orden = EXCLUDED.orden,
           latitud = EXCLUDED.latitud, longitud = EXCLUDED.longitud, manual = FALSE`,
        [courier.id, p.envioId, p.tipo, orden, p.latitud, p.longitud]
      );
    }
  }

  let anterior = inicio;
  return {
    fecha: new Date().toISOString().slice(0, 10),
    inicio,
    ordenManual: manual,
    kmRecorrido: Math.round(longitudRecorrido(inicio, ordenadas) * 10) / 10,
    kmOptimizado: resumen.kmOptimizado,
    kmOrdenRegistro: resumen.kmOrdenRegistro,
    ahorroPorcentaje: resumen.ahorroPorcentaje,
    paradas: ordenadas.map((p, i) => {
      const km = distanciaKm(anterior, p);
      anterior = p;
      return {
        orden: i + 1,
        tipo: p.tipo,
        latitud: p.latitud,
        longitud: p.longitud,
        kmDesdeAnterior: Math.round(km * 10) / 10,
        envio: aJson(porId.get(p.envioId))
      };
    }),
    // Recogidos o en tránsito: van en camino a la ciudad de destino; todavía no son paradas.
    enCamino: envios.filter((e) => e.estado === 'recogido' || e.estado === 'en_transito').map(aJson)
  };
}

/**
 * RF-C05 / RF-C06: cada entrega contraentrega lleva su cobro QR ya creado en Banco Andino. El courier lo
 * descarga con la ruta, así puede mostrarlo en la puerta aunque allí no tenga señal. De paso se verifican
 * con el banco los cobros que quedaron pendientes de confirmación. Si el banco no responde, la ruta sale igual.
 */
async function adjuntarCobros(req, ruta) {
  const { obtenerOCrearCobro, verificarPendientes, cobroAJson } = require('./pagos');
  const banco = crearClienteBanco(req);
  try {
    await verificarPendientes(banco, 'e.courier_id = $1', [req.usuario.id]);
  } catch (e) {
    // sin banco no se verifica ahora; se hará en la próxima sincronización
  }
  for (const parada of ruta.paradas) {
    if (parada.tipo !== 'entrega' || !(parada.envio.montoContraentrega > 0)) continue;
    try {
      const { rows } = await consulta('SELECT * FROM envios WHERE id = $1', [parada.envio.id]);
      parada.cobro = cobroAJson(await obtenerOCrearCobro(banco, rows[0], 'contraentrega', req.usuario.id), rows[0]);
    } catch (e) {
      parada.cobro = null;
    }
  }
}

async function courierActual(bd, req) {
  const { rows } = await bd.query("SELECT * FROM usuarios WHERE id = $1 AND rol = 'courier'", [req.usuario.id]);
  if (!rows[0]) throw error(403, 'SIN_PERMISO', 'Esta acción es de la App Courier.');
  return rows[0];
}

/** Desde dónde se ordena: la ubicación actual del courier si la envía, o la base de su zona. */
function inicioDeRuta(req, courier) {
  const { latitud, longitud } = leerUbicacion(req.query);
  return latitud !== null ? { latitud, longitud } : baseDeZona(courier.zona);
}

/** GET /api/courier/ruta[?latitud=&longitud=] → paradas del día ordenadas (RF-C01, ML-04). */
rutasCourier.get('/courier/ruta', conSesionDeCourier, async (req, res, next) => {
  try {
    const ruta = await transaccion(async (bd) => {
      const courier = await courierActual(bd, req);
      return construirRuta(bd, courier, inicioDeRuta(req, courier));
    });
    await adjuntarCobros(req, ruta);
    res.json(ruta);
  } catch (e) {
    next(e);
  }
});

/**
 * PUT /api/courier/ruta/orden → el courier reordena a mano (RF-C02). Cuerpo: paradas [{ envioId, tipo }]
 * en el orden nuevo; deben ser exactamente las paradas del día. El cambio queda registrado (manual = true).
 */
rutasCourier.put('/courier/ruta/orden', conSesionDeCourier, (req, res, next) => {
  ejecutarUnaVez(req, res, next, 'REORDENAR', async (bd) => {
    const courier = await courierActual(bd, req);
    const inicio = inicioDeRuta(req, courier);
    const actual = await construirRuta(bd, courier, inicio);
    const nuevas = Array.isArray(req.body?.paradas) ? req.body.paradas : [];
    const esperadas = new Set(actual.paradas.map((p) => `${p.envio.id}:${p.tipo}`));
    const recibidas = nuevas.map((p) => `${Number(p.envioId)}:${p.tipo}`);
    if (recibidas.length !== esperadas.size || new Set(recibidas).size !== esperadas.size || !recibidas.every((k) => esperadas.has(k))) {
      throw error(409, 'RUTA_CAMBIO', 'Tus paradas cambiaron: actualiza la ruta y vuelve a ordenarla.');
    }
    let orden = 0;
    for (const p of nuevas) {
      orden += 1;
      await bd.query(
        `UPDATE paradas SET orden = $1, manual = TRUE
         WHERE courier_id = $2 AND envio_id = $3 AND tipo = $4 AND fecha = CURRENT_DATE`,
        [orden, courier.id, Number(p.envioId), p.tipo]
      );
    }
    return { estado: 200, cuerpo: await construirRuta(bd, courier, inicio) };
  });
});

// Avances que registra el courier. La entrega no está aquí: se cierra con foto y firma (RN-03).
const TRANSICIONES = {
  recogido: ['pendiente'],
  en_transito: ['recogido'],
  en_reparto: ['en_transito', 'reprogramado']
};

const normalizarGuia = (g) => String(g || '').trim().toUpperCase();

/**
 * POST /api/envios/:id/eventos (courier, RF-C03 / RF-C08)
 * Cuerpo: uuidOperacion, estado, guia (al recoger: la escaneada), fechaHora (hora real), latitud, longitud.
 */
rutasCourier.post('/envios/:id/eventos', conSesionDeCourier, (req, res, next) => {
  ejecutarUnaVez(req, res, next, 'EVENTO', async (bd) => {
    const envio = await obtenerParaEditar(bd, req);
    const estado = String(req.body?.estado || '');
    if (estado === 'entregado') {
      throw error(422, 'USAR_EVIDENCIA', 'La entrega se cierra con foto, firma, nombre y DNI de quien recibe.');
    }
    if (!TRANSICIONES[estado]) {
      throw error(422, 'ESTADO_INVALIDO', 'El courier solo registra: recogido, en tránsito o en reparto.');
    }
    if (estado === 'recogido' && normalizarGuia(req.body?.guia) !== envio.numero_guia) {
      throw error(
        422,
        'GUIA_NO_COINCIDE',
        `La guía escaneada (${normalizarGuia(req.body?.guia) || 'vacía'}) no corresponde a esta parada (${envio.numero_guia}).`
      );
    }
    const fecha = leerFechaEvento(req.body?.fechaHora, envio);
    const { latitud, longitud } = leerUbicacion(req.body);

    // El mismo avance ya estaba aplicado (por ejemplo, reenviado sin señal con otro UUID): no se repite.
    if (envio.estado === estado) {
      return { estado: 200, cuerpo: aJson(envio), idEnvio: envio.id };
    }
    if (!TRANSICIONES[estado].includes(envio.estado)) {
      throw conflicto(
        'TRANSICION_INVALIDA',
        `No se puede pasar a ${ETIQUETAS[estado]}: el envío está ${ETIQUETAS[envio.estado]}.`,
        envio
      );
    }
    const { rows } = await bd.query(
      `UPDATE envios SET estado = $1, version = version + 1, actualizado_en = NOW() WHERE id = $2 RETURNING *`,
      [estado, envio.id]
    );
    // RN-06: el evento lleva la hora real en que ocurrió, aunque llegue después.
    await registrarEvento(bd, envio.id, estado, req.usuario.id, fecha, latitud, longitud);
    return { estado: 200, cuerpo: aJson(rows[0]), idEnvio: envio.id };
  });
});

/**
 * POST /api/envios/:id/evidencia (courier, RF-C04 / HU-C03)
 * Cuerpo: uuidOperacion, foto (JPEG base64), firma (PNG base64), recibeNombre, recibeDni, fechaHora, latitud, longitud.
 * RN-03: sin foto y firma no se cierra. RN-02: un contraentrega no se entrega sin cobro confirmado.
 */
rutasCourier.post('/envios/:id/evidencia', conSesionDeCourier, (req, res, next) => {
  ejecutarUnaVez(req, res, next, 'EVIDENCIA', async (bd) => {
    const envio = await obtenerParaEditar(bd, req);
    if (envio.estado !== 'en_reparto') {
      throw conflicto(
        'ESTADO_NO_PERMITE',
        `Solo se entrega un envío en reparto; ahora está ${ETIQUETAS[envio.estado]}.`,
        envio
      );
    }

    const recibeNombre = String(req.body?.recibeNombre || '').trim();
    const recibeDni = String(req.body?.recibeDni || '').trim();
    if (!recibeNombre || recibeNombre.length > 80) {
      throw error(422, 'RECEPTOR_INVALIDO', 'Escribe el nombre de quien recibe (hasta 80 caracteres).');
    }
    if (!/^\d{8}$/.test(recibeDni)) {
      throw error(422, 'DNI_INVALIDO', 'El DNI de quien recibe debe tener 8 dígitos.');
    }
    const foto = leerImagen(req.body?.foto, 'foto_entrega', { nombre: 'la foto de la entrega' });
    const firma = leerImagen(req.body?.firma, 'firma', { nombre: 'la firma del destinatario' });
    const fecha = leerFechaEvento(req.body?.fechaHora, envio);
    const { latitud, longitud } = leerUbicacion(req.body);

    if (Number(envio.monto_contraentrega) > 0) {
      const { rows } = await bd.query(
        `SELECT 1 FROM cobros WHERE envio_id = $1 AND tipo = 'contraentrega'
           AND estado IN ('PENDIENTE_CONFIRMACION', 'CONFIRMADO', 'LIQUIDADO')`,
        [envio.id]
      );
      if (rows.length === 0) {
        throw conflicto(
          'COBRO_PENDIENTE',
          `Primero cobra S/ ${Number(envio.monto_contraentrega).toFixed(2)} al destinatario: sin cobro no se entrega (RN-02).`,
          envio
        );
      }
    }

    const fotoUrl = await guardarArchivo(bd, envio.id, 'foto_entrega', foto, req.usuario.id);
    const firmaUrl = await guardarArchivo(bd, envio.id, 'firma', firma, req.usuario.id);
    await bd.query(
      `INSERT INTO evidencias (envio_id, foto_url, firma_url, recibe_nombre, recibe_dni, fecha_hora, latitud, longitud)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [envio.id, fotoUrl, firmaUrl, recibeNombre, recibeDni, fecha, latitud, longitud]
    );
    const { rows } = await bd.query(
      `UPDATE envios SET estado = 'entregado', version = version + 1, actualizado_en = NOW() WHERE id = $1 RETURNING *`,
      [envio.id]
    );
    await registrarEvento(bd, envio.id, 'entregado', req.usuario.id, fecha, latitud, longitud);
    return { estado: 201, cuerpo: aJson(rows[0]), idEnvio: envio.id };
  });
});

module.exports = { rutasCourier };
