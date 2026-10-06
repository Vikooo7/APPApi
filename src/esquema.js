const bcrypt = require('bcryptjs');
const { transaccion } = require('./db');

/** Esquema de la base remota (PostgreSQL en Neon). El mismo SQL está en db/esquema.sql. */
const TABLAS = [
  `CREATE TABLE IF NOT EXISTS usuarios (
     id          SERIAL PRIMARY KEY,
     nombre      TEXT NOT NULL,
     correo      TEXT NOT NULL UNIQUE,
     clave_hash  TEXT NOT NULL,
     rol         TEXT NOT NULL CHECK (rol IN ('cliente', 'administrador'))
   )`,
  `CREATE TABLE IF NOT EXISTS rutas (
     id              SERIAL PRIMARY KEY,
     nombre          TEXT NOT NULL UNIQUE,
     tiempo_estimado INTEGER NOT NULL,
     tarifa_por_kg   NUMERIC(8, 2) NOT NULL,
     region          TEXT NOT NULL,
     activa          BOOLEAN NOT NULL DEFAULT TRUE
   )`,
  `CREATE TABLE IF NOT EXISTS envios (
     id                     SERIAL PRIMARY KEY,
     uuid                   UUID NOT NULL UNIQUE,
     numero_guia            TEXT NOT NULL UNIQUE,
     ruta                   TEXT NOT NULL,
     peso_kg                NUMERIC(10, 2) NOT NULL CHECK (peso_kg > 0),
     costo_envio            NUMERIC(12, 2) NOT NULL,
     estado                 TEXT NOT NULL DEFAULT 'pendiente'
                              CHECK (estado IN ('pendiente', 'recogido', 'en_transito', 'en_reparto', 'entregado')),
     transportista_asignado TEXT,
     usuario_id             INTEGER NOT NULL REFERENCES usuarios (id),
     version                INTEGER NOT NULL DEFAULT 1,
     eliminado              BOOLEAN NOT NULL DEFAULT FALSE,
     actualizado_en         TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,
  // RF15: cada operación de escritura llega con un UUID; si se repite, no se aplica dos veces.
  `CREATE TABLE IF NOT EXISTS operaciones_procesadas (
     uuid_operacion UUID PRIMARY KEY,
     usuario_id     INTEGER NOT NULL REFERENCES usuarios (id),
     tipo           TEXT NOT NULL,
     id_envio       INTEGER,
     estado_http    INTEGER NOT NULL,
     respuesta      JSONB NOT NULL,
     fecha          TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`
];

const USUARIOS = [
  ['Distribuidora Andina SAC', 'cliente@rutalog.pe', '1234', 'cliente'],
  ['Textiles Gamarra EIRL', 'cliente2@rutalog.pe', '1234', 'cliente'],
  ['Central de Operaciones Lima', 'operador@rutalog.pe', '1234', 'administrador']
];

// nombre, tiempo estimado (h), tarifa por kg (S/), región
const RUTAS = [
  ['Lima → Lima (urbano)', 3, 0.8, 'Lima'],
  ['Lima → Callao', 2, 0.7, 'Callao'],
  ['Lima → Tumbes', 20, 3.4, 'Tumbes'],
  ['Lima → Piura', 15, 2.8, 'Piura'],
  ['Lima → Chiclayo', 12, 2.4, 'Lambayeque'],
  ['Lima → Trujillo', 9, 1.9, 'La Libertad'],
  ['Lima → Cajamarca', 14, 2.6, 'Cajamarca'],
  ['Lima → Huaraz', 8, 1.7, 'Áncash'],
  ['Lima → Huánuco', 8, 1.7, 'Huánuco'],
  ['Lima → Cerro de Pasco', 7, 1.5, 'Pasco'],
  ['Lima → Huancayo', 7, 1.5, 'Junín'],
  ['Lima → Huancavelica', 10, 1.8, 'Huancavelica'],
  ['Lima → Ayacucho', 9, 1.9, 'Ayacucho'],
  ['Lima → Ica', 4, 1.4, 'Ica'],
  ['Lima → Abancay', 16, 2.7, 'Apurímac'],
  ['Lima → Cusco', 22, 3.1, 'Cusco'],
  ['Lima → Arequipa', 16, 2.9, 'Arequipa'],
  ['Lima → Puno', 20, 3.4, 'Puno'],
  ['Lima → Moquegua', 17, 3.1, 'Moquegua'],
  ['Lima → Tacna', 19, 3.3, 'Tacna'],
  ['Lima → Chachapoyas', 22, 3.3, 'Amazonas'],
  ['Lima → Tarapoto', 24, 3.6, 'San Martín'],
  ['Lima → Iquitos', 96, 4.8, 'Loreto'],
  ['Lima → Pucallpa', 18, 2.5, 'Ucayali'],
  ['Lima → Puerto Maldonado', 28, 4.2, 'Madre de Dios'],
  ['Arequipa → Puno', 6, 1.4, 'Puno'],
  ['Cusco → Puerto Maldonado', 10, 1.9, 'Madre de Dios']
];

// correo del dueño, ruta, peso (kg), estado, transportista
const ENVIOS = [
  ['cliente@rutalog.pe', 'Lima → Arequipa', 120.5, 'en_transito', 'Carlos Quispe Mamani · AQP-482'],
  ['cliente@rutalog.pe', 'Lima → Trujillo', 45, 'entregado', 'Rosa Huamán Torres · BFK-209'],
  ['cliente@rutalog.pe', 'Lima → Cusco', 300, 'recogido', 'Wilber Condori Apaza · X3C-560'],
  ['cliente@rutalog.pe', 'Lima → Iquitos', 80, 'en_transito', 'Edwin Tapullima Sangama · U4S-218'],
  ['cliente@rutalog.pe', 'Lima → Piura', 15.5, 'pendiente', null],
  ['cliente@rutalog.pe', 'Lima → Huancayo', 220, 'en_reparto', 'Milagros Rojas Pérez · F7R-318'],
  ['cliente@rutalog.pe', 'Lima → Tacna', 60, 'entregado', 'Yeni Mamani Choque · Z9P-640'],
  ['cliente@rutalog.pe', 'Lima → Chiclayo', 35, 'pendiente', null],
  ['cliente2@rutalog.pe', 'Lima → Ica', 18, 'pendiente', null],
  ['cliente2@rutalog.pe', 'Lima → Puno', 90, 'en_transito', 'Yeni Mamani Choque · Z9P-640']
];

/** Guía RLP-AA-NNNNNN-D: el mismo formato que usa la app (NumeroGuia.kt). */
function generarGuia(correlativo, fecha = new Date()) {
  const base = String(correlativo);
  const verificador = base.split('').reduce((suma, digito) => suma + Number(digito), 0) % 10;
  const anio = String(fecha.getFullYear() % 100).padStart(2, '0');
  return `RLP-${anio}-${base}-${verificador}`;
}

async function crearEsquema() {
  await transaccion(async (bd) => {
    // Evita que dos arranques simultáneos creen las tablas o los datos dos veces.
    await bd.query('SELECT pg_advisory_xact_lock(20261007)');

    for (const sql of TABLAS) {
      await bd.query(sql);
    }

    const { rows } = await bd.query('SELECT COUNT(*)::int AS total FROM usuarios');
    if (rows[0].total > 0) return;

    for (const [nombre, correo, clave, rol] of USUARIOS) {
      await bd.query(
        'INSERT INTO usuarios (nombre, correo, clave_hash, rol) VALUES ($1, $2, $3, $4)',
        [nombre, correo, bcrypt.hashSync(clave, 10), rol]
      );
    }

    for (const [nombre, tiempo, tarifa, region] of RUTAS) {
      await bd.query(
        'INSERT INTO rutas (nombre, tiempo_estimado, tarifa_por_kg, region) VALUES ($1, $2, $3, $4)',
        [nombre, tiempo, tarifa, region]
      );
    }

    let correlativo = 100000;
    for (const [correo, ruta, peso, estado, transportista] of ENVIOS) {
      correlativo += 1;
      await bd.query(
        `INSERT INTO envios (uuid, numero_guia, ruta, peso_kg, costo_envio, estado, transportista_asignado, usuario_id)
         SELECT gen_random_uuid(), $1::text, r.nombre, $2::numeric,
                ROUND($2::numeric * r.tarifa_por_kg, 2), $3::text, $4::text, u.id
         FROM rutas r, usuarios u
         WHERE r.nombre = $5::text AND u.correo = $6::text`,
        [generarGuia(correlativo), peso, estado, transportista, ruta, correo]
      );
    }
  });
}

let listo;

/** Crea las tablas y los datos de ejemplo la primera vez; después no hace nada. */
function asegurarEsquema() {
  if (!listo) {
    listo = crearEsquema().catch((error) => {
      listo = undefined;
      throw error;
    });
  }
  return listo;
}

module.exports = { asegurarEsquema, generarGuia };
