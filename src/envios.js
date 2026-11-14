const express = require('express');
const { consulta, transaccion } = require('./db');
const { error } = require('./auth');
const { generarGuia } = require('./esquema');

const rutasEnvios = express.Router();

// Flujo normal del envío. "pendiente" es el REGISTRADO de la ficha del proyecto final.
const ESTADOS = ['pendiente', 'recogido', 'en_transito', 'en_reparto', 'entregado'];
// Fuera del flujo: los registra el courier (fallido) o el operador (reprogramado); devuelto tras 3 intentos.
const ESTADOS_ENTREGA_FALLIDA = ['fallido', 'reprogramado', 'devuelto'];
const ESTADOS_CERRADOS = ['entregado', 'devuelto'];
const MAX_INTENTOS = 3;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PESO_MAXIMO = 30000;

function aJson(fila) {
  return {
    id: fila.id,
    uuid: fila.uuid,
    numeroGuia: fila.numero_guia,
    ruta: fila.ruta,
    pesoKg: Number(fila.peso_kg),
    costoEnvio: Number(fila.costo_envio),
    estado: fila.estado,
    transportistaAsignado: fila.transportista_asignado,
    courierId: fila.courier_id ?? null,
    destinatarioNombre: fila.destinatario_nombre ?? null,
    destinatarioTelefono: fila.destinatario_telefono ?? null,
    destinatarioDireccion: fila.destinatario_direccion ?? null,
    montoContraentrega: Number(fila.monto_contraentrega ?? 0),
    intentos: fila.intentos ?? 0,
    version: fila.version,
    actualizadoEn: fila.actualizado_en
  };
}

/** Operador y administrador ven y gestionan todos los envíos (App Admin). */
function esOperacion(req) {
  return req.usuario.rol === 'operador' || req.usuario.rol === 'administrador';
}

function esCourier(req) {
  return req.usuario.rol === 'courier';
}

/** Cliente: solo sus envíos. Courier: solo los que tiene asignados. Operación: todos. */
function puedeVer(req, envio) {
  if (esOperacion(req)) return true;
  if (esCourier(req)) return envio.courier_id === req.usuario.id;
  return envio.usuario_id === req.usuario.id;
}

/** Texto "Nombre · Placa" que guarda transportista_asignado, como en el parcial. */
function etiquetaCourier(courier) {
  return `${courier.nombre} · ${courier.placa}`;
}

/** Envíos que el courier todavía tiene en curso: cuentan para su capacidad de paradas. */
async function contarActivos(bd, courierId, excluirIds = []) {
  const { rows } = await bd.query(
    `SELECT COUNT(*)::int AS total FROM envios
     WHERE courier_id = $1 AND NOT eliminado AND estado <> ALL($2::text[]) AND id <> ALL($3::int[])`,
    [courierId, ESTADOS_CERRADOS, excluirIds]
  );
  return rows[0].total;
}

/**
 * El operador indica el courier por su id (App Admin nueva) o por el texto "Nombre · Placa"
 * (App Admin del parcial). En ambos casos debe ser un usuario con rol courier.
 */
async function resolverCourier(bd, { courierId, transportista }) {
  let resultado;
  if (courierId !== undefined && courierId !== null) {
    resultado = await bd.query("SELECT * FROM usuarios WHERE id = $1 AND rol = 'courier'", [Number(courierId)]);
  } else if (transportista) {
    resultado = await bd.query(
      "SELECT * FROM usuarios WHERE rol = 'courier' AND nombre || ' · ' || placa = $1",
      [String(transportista)]
    );
  } else {
    return null;
  }
  if (!resultado.rows[0]) {
    throw error(422, 'COURIER_INVALIDO', 'El transportista indicado no está registrado como courier.');
  }
  return resultado.rows[0];
}

/** RF-O01: máximo de paradas activas por courier (capacidad, 30 por defecto). */
async function validarCapacidad(bd, courier, nuevosIds) {
  const activos = await contarActivos(bd, courier.id, nuevosIds);
  if (activos + nuevosIds.length > courier.capacidad) {
    const libres = Math.max(courier.capacidad - activos, 0);
    throw error(
      422,
      'CAPACIDAD_EXCEDIDA',
      `${courier.nombre} ya tiene ${activos} de ${courier.capacidad} paradas: solo puede recibir ${libres} más.`
    );
  }
}

/** RN-06: cada cambio de estado queda con la hora real en que ocurrió. */
async function registrarEvento(bd, envioId, estado, usuarioId, fechaHora = new Date(), latitud = null, longitud = null) {
  await bd.query(
    `INSERT INTO eventos_envio (id, envio_id, estado, fecha_hora_evento, latitud, longitud, usuario_id)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6)`,
    [envioId, estado, fechaHora, latitud, longitud, usuarioId]
  );
}

function leerUuidOperacion(req) {
  const valor = req.body?.uuidOperacion || req.query.uuidOperacion || req.get('x-uuid-operacion');
  if (!valor || !UUID.test(valor)) {
    throw error(400, 'UUID_INVALIDO', 'Falta el identificador único (UUID) de la operación.');
  }
  return String(valor).toLowerCase();
}

function validarPeso(valor) {
  const peso = Number(valor);
  if (!Number.isFinite(peso)) {
    throw error(422, 'PESO_INVALIDO', 'El peso debe ser un número.');
  }
  if (peso <= 0) {
    throw error(422, 'PESO_INVALIDO', 'El peso debe ser mayor que 0 kg.');
  }
  if (peso > PESO_MAXIMO) {
    throw error(422, 'PESO_INVALIDO', 'El peso máximo por envío es 30 000 kg.');
  }
  return Math.round(peso * 100) / 100;
}

async function buscarRuta(bd, nombre) {
  const { rows } = await bd.query('SELECT * FROM rutas WHERE nombre = $1 AND activa', [String(nombre || '')]);
  if (!rows[0]) {
    throw error(422, 'RUTA_INVALIDA', 'La ruta seleccionada no existe o no está activa.');
  }
  return rows[0];
}

function calcularCosto(pesoKg, ruta) {
  return Math.round(pesoKg * Number(ruta.tarifa_por_kg) * 100) / 100;
}

/**
 * RF15: ejecuta una escritura una sola vez por UUID de operación.
 * Si el mismo UUID llega de nuevo (reintento), devuelve la respuesta guardada sin repetir el cambio.
 */
async function ejecutarUnaVez(req, res, next, tipo, fn) {
  try {
    const uuidOperacion = leerUuidOperacion(req);
    const resultado = await transaccion(async (bd) => {
      // Dos reintentos simultáneos del mismo UUID esperan aquí en vez de duplicar.
      await bd.query('SELECT pg_advisory_xact_lock(hashtext($1))', [uuidOperacion]);

      const previa = await bd.query(
        'SELECT estado_http, respuesta FROM operaciones_procesadas WHERE uuid_operacion = $1',
        [uuidOperacion]
      );
      if (previa.rows[0]) {
        return { estado: previa.rows[0].estado_http, cuerpo: { ...previa.rows[0].respuesta, duplicado: true } };
      }

      const { estado, cuerpo, idEnvio } = await fn(bd);
      await bd.query(
        `INSERT INTO operaciones_procesadas (uuid_operacion, usuario_id, tipo, id_envio, estado_http, respuesta)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [uuidOperacion, req.usuario.id, tipo, idEnvio || null, estado, JSON.stringify(cuerpo)]
      );
      return { estado, cuerpo };
    });
    res.status(resultado.estado).json(resultado.cuerpo);
  } catch (e) {
    next(e);
  }
}

/** Busca el envío bloqueándolo para la transacción y comprueba que el usuario pueda verlo. */
async function obtenerParaEditar(bd, req) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    throw error(400, 'ID_INVALIDO', 'El identificador del envío no es válido.');
  }
  const { rows } = await bd.query('SELECT * FROM envios WHERE id = $1 FOR UPDATE', [id]);
  const envio = rows[0];
  if (!envio) {
    throw error(404, 'NO_ENCONTRADO', 'El envío no existe en el servidor.');
  }
  if (!puedeVer(req, envio)) {
    throw error(403, 'SIN_PERMISO', 'Este envío pertenece a otro cliente.');
  }
  return envio;
}

/** Conflicto: el servidor rechaza el cambio y devuelve cómo está el envío realmente. */
function conflicto(codigo, mensaje, envio) {
  const e = error(409, codigo, mensaje);
  e.extra = { envio: aJson(envio) };
  return e;
}

const ETIQUETAS = {
  pendiente: 'pendiente de recojo',
  recogido: 'recogido',
  en_transito: 'en tránsito',
  en_reparto: 'en reparto',
  entregado: 'entregado',
  fallido: 'con entrega fallida',
  reprogramado: 'reprogramado',
  devuelto: 'devuelto al remitente'
};

/** Un envío reprogramado vuelve a salir a reparto: cuenta como "en tránsito" para no retroceder. */
function posicion(estado) {
  return estado === 'reprogramado' ? ESTADOS.indexOf('en_transito') : ESTADOS.indexOf(estado);
}

/**
 * Reglas del operador al cambiar estado y transportista (RF08 y RF09 del parcial).
 * Son las mismas que aplica la App Admin antes de guardar; el servidor las repite
 * porque un cambio hecho sin conexión puede llegar cuando el envío ya avanzó.
 */
function validarCambioAdministrador(envio, estado, transportista) {
  // Fallido y reprogramado no se eligen aquí, pero se mantienen si solo cambia el courier.
  if (!ESTADOS.includes(estado) && estado !== envio.estado) {
    throw error(422, 'ESTADO_INVALIDO', 'El estado indicado no existe.');
  }
  if (envio.estado === 'entregado') {
    throw conflicto(
      'ENVIO_CERRADO',
      'El envío ya fue entregado: su estado y transportista no se pueden cambiar.',
      envio
    );
  }
  if (envio.estado === 'devuelto') {
    throw conflicto(
      'ENVIO_CERRADO',
      'El envío fue devuelto al remitente tras 3 intentos fallidos: ya no se puede cambiar.',
      envio
    );
  }
  if (envio.estado === 'fallido' && estado !== 'fallido') {
    throw conflicto(
      'ENTREGA_FALLIDA',
      'La entrega falló: reprográmala antes de cambiar el estado.',
      envio
    );
  }
  if (posicion(estado) < posicion(envio.estado)) {
    throw conflicto(
      'ESTADO_NO_RETROCEDE',
      `El estado solo puede avanzar: el envío ya está ${ETIQUETAS[envio.estado]}.`,
      envio
    );
  }
  if (estado !== 'pendiente' && !transportista) {
    throw error(422, 'SIN_TRANSPORTISTA', 'Asigna un transportista antes de cambiar el estado.');
  }
}

/**
 * GET /api/envios → cliente: sus envíos; courier: los asignados; operación: todos.
 * Filtros: ?estado=, ?ruta=, ?zona= y ?courierId= (este último, solo operación).
 */
rutasEnvios.get('/', async (req, res, next) => {
  try {
    const condiciones = ['NOT eliminado'];
    const parametros = [];
    if (esCourier(req)) {
      parametros.push(req.usuario.id);
      condiciones.push(`courier_id = $${parametros.length}`);
    } else if (!esOperacion(req)) {
      parametros.push(req.usuario.id);
      condiciones.push(`usuario_id = $${parametros.length}`);
    } else if (req.query.courierId) {
      parametros.push(Number(req.query.courierId));
      condiciones.push(`courier_id = $${parametros.length}`);
    }
    if (req.query.zona) {
      parametros.push(String(req.query.zona));
      condiciones.push(`ruta IN (SELECT nombre FROM rutas WHERE zona = $${parametros.length})`);
    }
    if (req.query.estado) {
      parametros.push(String(req.query.estado));
      condiciones.push(`estado = $${parametros.length}`);
    }
    if (req.query.ruta) {
      parametros.push(String(req.query.ruta));
      condiciones.push(`ruta = $${parametros.length}`);
    }
    const { rows } = await consulta(
      `SELECT * FROM envios WHERE ${condiciones.join(' AND ')} ORDER BY id DESC`,
      parametros
    );
    res.json({ datos: rows.map(aJson), servidorAhora: new Date().toISOString() });
  } catch (e) {
    next(e);
  }
});

/** GET /api/envios/:id */
rutasEnvios.get('/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      throw error(400, 'ID_INVALIDO', 'El identificador del envío no es válido.');
    }
    const { rows } = await consulta('SELECT * FROM envios WHERE id = $1 AND NOT eliminado', [id]);
    const envio = rows[0];
    if (!envio) {
      throw error(404, 'NO_ENCONTRADO', 'El envío no existe en el servidor.');
    }
    if (!puedeVer(req, envio)) {
      throw error(403, 'SIN_PERMISO', 'Este envío pertenece a otro cliente.');
    }
    res.json(aJson(envio));
  } catch (e) {
    next(e);
  }
});

/** POST /api/envios → registra un envío del cliente. Cuerpo: uuidOperacion, uuid, numeroGuia, ruta, pesoKg */
rutasEnvios.post('/', (req, res, next) => {
  ejecutarUnaVez(req, res, next, 'CREAR', async (bd) => {
    if (req.usuario.rol !== 'cliente') {
      throw error(403, 'SIN_PERMISO', 'Solo los clientes registran envíos.');
    }
    const uuid = String(req.body?.uuid || '').toLowerCase();
    if (!UUID.test(uuid)) {
      throw error(400, 'UUID_INVALIDO', 'Falta el identificador único (UUID) del envío.');
    }

    // El mismo envío ya llegó en otra operación: se devuelve tal cual, sin duplicarlo.
    const existente = await bd.query('SELECT * FROM envios WHERE uuid = $1', [uuid]);
    if (existente.rows[0]) {
      return { estado: 200, cuerpo: aJson(existente.rows[0]), idEnvio: existente.rows[0].id };
    }

    const pesoKg = validarPeso(req.body?.pesoKg);
    const ruta = await buscarRuta(bd, req.body?.ruta);

    // La guía que generó la app se respeta si está libre; si otro envío ya la usa,
    // el servidor asigna una nueva a partir de su propio correlativo.
    const guiaPropuesta = String(req.body?.numeroGuia || '').trim().toUpperCase();
    const ocupada = guiaPropuesta
      ? (await bd.query('SELECT 1 FROM envios WHERE numero_guia = $1', [guiaPropuesta])).rows.length > 0
      : true;
    const guiaTemporal = ocupada ? `TMP-${uuid}` : guiaPropuesta;

    const insertado = await bd.query(
      `INSERT INTO envios (uuid, numero_guia, ruta, peso_kg, costo_envio, usuario_id)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [uuid, guiaTemporal, ruta.nombre, pesoKg, calcularCosto(pesoKg, ruta), req.usuario.id]
    );
    let envio = insertado.rows[0];

    if (ocupada) {
      const corregido = await bd.query(
        'UPDATE envios SET numero_guia = $1 WHERE id = $2 RETURNING *',
        [generarGuia(500000 + envio.id), envio.id]
      );
      envio = corregido.rows[0];
    }

    return { estado: 201, cuerpo: aJson(envio), idEnvio: envio.id };
  });
});

/** Rechaza el cambio si la app lo hizo sobre una versión que ya no es la del servidor. */
function validarVersion(req, envio) {
  const versionCliente = Number(req.body?.version);
  if (Number.isInteger(versionCliente) && versionCliente !== envio.version) {
    throw conflicto(
      'VERSION_DESACTUALIZADA',
      'El envío cambió en el servidor después de tu última sincronización.',
      envio
    );
  }
}

/**
 * PUT /api/envios/:id
 * Cliente: cambia ruta y peso de un envío propio que sigue pendiente.
 * Operador y administrador: cambian estado y courier (courierId, o transportistaAsignado como en el parcial).
 */
rutasEnvios.put('/:id', (req, res, next) => {
  ejecutarUnaVez(req, res, next, 'ACTUALIZAR', async (bd) => {
    if (esCourier(req)) {
      throw error(403, 'SIN_PERMISO', 'El courier registra recojos y entregas desde su propia app.');
    }
    const envio = await obtenerParaEditar(bd, req);
    if (envio.eliminado) {
      throw error(404, 'NO_ENCONTRADO', 'El envío fue eliminado en el servidor.');
    }
    validarVersion(req, envio);

    let actualizado;
    if (esOperacion(req)) {
      const estado = req.body?.estado ?? envio.estado;
      const cambiaCourier = req.body?.courierId !== undefined || req.body?.transportistaAsignado !== undefined;
      const courier = cambiaCourier
        ? await resolverCourier(bd, { courierId: req.body?.courierId, transportista: req.body?.transportistaAsignado })
        : envio.courier_id
          ? (await bd.query('SELECT * FROM usuarios WHERE id = $1', [envio.courier_id])).rows[0]
          : null;

      // Un transportista escrito en el parcial que no es courier se conserva hasta que lo reasignen.
      const etiqueta = courier ? etiquetaCourier(courier) : cambiaCourier ? null : envio.transportista_asignado;
      validarCambioAdministrador(envio, estado, etiqueta);
      if (courier && courier.id !== envio.courier_id) {
        await validarCapacidad(bd, courier, [envio.id]);
      }

      actualizado = await bd.query(
        `UPDATE envios SET estado = $1, courier_id = $2, transportista_asignado = $3,
                version = version + 1, actualizado_en = NOW()
         WHERE id = $4 RETURNING *`,
        [estado, courier ? courier.id : null, etiqueta, envio.id]
      );
      if (estado !== envio.estado) {
        await registrarEvento(bd, envio.id, estado, req.usuario.id);
      }
    } else {
      if (envio.estado !== 'pendiente') {
        throw conflicto(
          'ENVIO_NO_EDITABLE',
          'La carga ya fue recogida: el envío no se puede modificar.',
          envio
        );
      }
      const pesoKg = validarPeso(req.body?.pesoKg ?? envio.peso_kg);
      const ruta = await buscarRuta(bd, req.body?.ruta ?? envio.ruta);
      actualizado = await bd.query(
        `UPDATE envios SET ruta = $1, peso_kg = $2, costo_envio = $3, version = version + 1, actualizado_en = NOW()
         WHERE id = $4 RETURNING *`,
        [ruta.nombre, pesoKg, calcularCosto(pesoKg, ruta), envio.id]
      );
    }

    return { estado: 200, cuerpo: aJson(actualizado.rows[0]), idEnvio: envio.id };
  });
});

/** DELETE /api/envios/:id?uuidOperacion=…&version=… → solo envíos pendientes. */
rutasEnvios.delete('/:id', (req, res, next) => {
  ejecutarUnaVez(req, res, next, 'ELIMINAR', async (bd) => {
    if (esCourier(req)) {
      throw error(403, 'SIN_PERMISO', 'El courier no puede eliminar envíos.');
    }
    const envio = await obtenerParaEditar(bd, req);
    if (envio.eliminado) {
      return { estado: 200, cuerpo: { id: envio.id, eliminado: true }, idEnvio: envio.id };
    }
    if (envio.estado !== 'pendiente') {
      throw conflicto(
        'ENVIO_NO_EDITABLE',
        'La carga ya fue recogida: el envío no se puede eliminar.',
        envio
      );
    }
    await bd.query(
      'UPDATE envios SET eliminado = TRUE, version = version + 1, actualizado_en = NOW() WHERE id = $1',
      [envio.id]
    );
    return { estado: 200, cuerpo: { id: envio.id, eliminado: true }, idEnvio: envio.id };
  });
});

const MOTIVOS_FALLA = ['ausente', 'direccion_errada', 'rechazado', 'zona_inaccesible'];

/** Hora real del evento enviada por la app (RN-06). No se acepta una hora en el futuro. */
function leerFechaEvento(valor) {
  if (valor === undefined || valor === null || valor === '') return new Date();
  const fecha = new Date(valor);
  if (Number.isNaN(fecha.getTime())) {
    throw error(422, 'FECHA_INVALIDA', 'La fecha y hora del evento no son válidas.');
  }
  if (fecha.getTime() > Date.now() + 5 * 60 * 1000) {
    throw error(422, 'FECHA_INVALIDA', 'La fecha del evento no puede estar en el futuro.');
  }
  return fecha;
}

/**
 * POST /api/envios/:id/fallido (courier, RF-C07)
 * Cuerpo: uuidOperacion, motivo, fotoUrl, fechaHora, latitud, longitud.
 * RN-05: al tercer intento el envío pasa a DEVUELTO.
 */
rutasEnvios.post('/:id/fallido', (req, res, next) => {
  ejecutarUnaVez(req, res, next, 'FALLIDO', async (bd) => {
    if (!esCourier(req)) {
      throw error(403, 'SIN_PERMISO', 'Solo el courier asignado registra una entrega fallida.');
    }
    const envio = await obtenerParaEditar(bd, req);
    if (envio.estado !== 'en_reparto' && envio.estado !== 'reprogramado') {
      throw conflicto(
        'ESTADO_NO_PERMITE',
        `Solo se registra una entrega fallida si el envío está en reparto; ahora está ${ETIQUETAS[envio.estado]}.`,
        envio
      );
    }
    const motivo = String(req.body?.motivo || '');
    if (!MOTIVOS_FALLA.includes(motivo)) {
      throw error(422, 'MOTIVO_INVALIDO', 'Elige el motivo: ausente, dirección errada, rechazado o zona inaccesible.');
    }
    const fecha = leerFechaEvento(req.body?.fechaHora);
    const latitud = req.body?.latitud ?? null;
    const longitud = req.body?.longitud ?? null;

    const numero = envio.intentos + 1;
    const estado = numero >= MAX_INTENTOS ? 'devuelto' : 'fallido';
    await bd.query(
      `INSERT INTO intentos_fallidos (envio_id, numero, motivo, foto_url, fecha, courier_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [envio.id, numero, motivo, req.body?.fotoUrl || null, fecha, req.usuario.id]
    );
    const actualizado = await bd.query(
      `UPDATE envios SET estado = $1, intentos = $2, version = version + 1, actualizado_en = NOW()
       WHERE id = $3 RETURNING *`,
      [estado, numero, envio.id]
    );
    await registrarEvento(bd, envio.id, 'fallido', req.usuario.id, fecha, latitud, longitud);
    if (estado === 'devuelto') {
      await registrarEvento(bd, envio.id, 'devuelto', req.usuario.id, fecha, latitud, longitud);
    }
    return { estado: 201, cuerpo: aJson(actualizado.rows[0]), idEnvio: envio.id };
  });
});

/**
 * POST /api/envios/:id/reprogramar (operador o administrador)
 * Cuerpo: uuidOperacion, version y, si se quiere cambiar, courierId.
 */
rutasEnvios.post('/:id/reprogramar', (req, res, next) => {
  ejecutarUnaVez(req, res, next, 'REPROGRAMAR', async (bd) => {
    if (!esOperacion(req)) {
      throw error(403, 'SIN_PERMISO', 'Solo el operador reprograma entregas.');
    }
    const envio = await obtenerParaEditar(bd, req);
    validarVersion(req, envio);
    if (envio.estado !== 'fallido') {
      throw conflicto(
        'ESTADO_NO_PERMITE',
        `Solo se reprograma una entrega fallida; el envío está ${ETIQUETAS[envio.estado]}.`,
        envio
      );
    }

    let courierId = envio.courier_id;
    let etiqueta = envio.transportista_asignado;
    if (req.body?.courierId !== undefined && req.body?.courierId !== null) {
      const courier = await resolverCourier(bd, { courierId: req.body.courierId });
      if (courier.id !== envio.courier_id) {
        await validarCapacidad(bd, courier, [envio.id]);
      }
      courierId = courier.id;
      etiqueta = etiquetaCourier(courier);
    }

    const actualizado = await bd.query(
      `UPDATE envios SET estado = 'reprogramado', courier_id = $1, transportista_asignado = $2,
              version = version + 1, actualizado_en = NOW()
       WHERE id = $3 RETURNING *`,
      [courierId, etiqueta, envio.id]
    );
    await registrarEvento(bd, envio.id, 'reprogramado', req.usuario.id);
    return { estado: 200, cuerpo: aJson(actualizado.rows[0]), idEnvio: envio.id };
  });
});

module.exports = {
  rutasEnvios,
  validarCambioAdministrador,
  aJson,
  ejecutarUnaVez,
  esOperacion,
  resolverCourier,
  validarCapacidad,
  contarActivos,
  etiquetaCourier,
  ESTADOS_CERRADOS,
  MAX_INTENTOS
};
