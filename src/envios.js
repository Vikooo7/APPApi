const express = require('express');
const { consulta, transaccion } = require('./db');
const { error } = require('./auth');
const { generarGuia } = require('./esquema');

const rutasEnvios = express.Router();

const ESTADOS = ['pendiente', 'recogido', 'en_transito', 'en_reparto', 'entregado'];
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
    version: fila.version,
    actualizadoEn: fila.actualizado_en
  };
}

function esAdministrador(req) {
  return req.usuario.rol === 'administrador';
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
  if (!esAdministrador(req) && envio.usuario_id !== req.usuario.id) {
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

/** GET /api/envios → el cliente recibe solo sus envíos; el administrador, todos. */
rutasEnvios.get('/', async (req, res, next) => {
  try {
    const condiciones = ['NOT eliminado'];
    const parametros = [];
    if (!esAdministrador(req)) {
      parametros.push(req.usuario.id);
      condiciones.push(`usuario_id = $${parametros.length}`);
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
    if (!esAdministrador(req) && envio.usuario_id !== req.usuario.id) {
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
    if (esAdministrador(req)) {
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

/**
 * PUT /api/envios/:id
 * Cliente: cambia ruta y peso de un envío propio que sigue pendiente.
 * Administrador: cambia estado y transportista.
 */
rutasEnvios.put('/:id', (req, res, next) => {
  ejecutarUnaVez(req, res, next, 'ACTUALIZAR', async (bd) => {
    const envio = await obtenerParaEditar(bd, req);
    if (envio.eliminado) {
      throw error(404, 'NO_ENCONTRADO', 'El envío fue eliminado en el servidor.');
    }

    const versionCliente = Number(req.body?.version);
    if (Number.isInteger(versionCliente) && versionCliente !== envio.version) {
      throw conflicto(
        'VERSION_DESACTUALIZADA',
        'El envío cambió en el servidor después de tu última sincronización.',
        envio
      );
    }

    let actualizado;
    if (esAdministrador(req)) {
      const estado = req.body?.estado ?? envio.estado;
      if (!ESTADOS.includes(estado)) {
        throw error(422, 'ESTADO_INVALIDO', 'El estado indicado no existe.');
      }
      const transportista = req.body?.transportistaAsignado ?? envio.transportista_asignado;
      if (estado !== 'pendiente' && !transportista) {
        throw error(422, 'SIN_TRANSPORTISTA', 'Asigna un transportista antes de cambiar el estado.');
      }
      actualizado = await bd.query(
        `UPDATE envios SET estado = $1, transportista_asignado = $2, version = version + 1, actualizado_en = NOW()
         WHERE id = $3 RETURNING *`,
        [estado, transportista || null, envio.id]
      );
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

module.exports = { rutasEnvios };
