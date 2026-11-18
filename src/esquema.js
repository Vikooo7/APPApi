const bcrypt = require('bcryptjs');
const { transaccion } = require('./db');
const { coordenadasEnvio } = require('./rutas-optimas');
const { PASOS_BANCO, datosBanco } = require('./banco/datos');

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

// RF06 de la App Operador: debe consultar al menos 30 envíos. Estos 30 se agregan una sola vez,
// también a las bases que ya tenían los 10 de arriba; con ellos el servidor llega a 40.
// Mismo orden: correo del dueño, ruta, peso (kg), estado, transportista.
const ENVIOS_ADICIONALES = [
  ['cliente@rutalog.pe', 'Lima → Arequipa', 64, 'pendiente', null],
  ['cliente2@rutalog.pe', 'Lima → Trujillo', 150, 'recogido', 'Jorge Castillo Vega · T2L-771'],
  ['cliente@rutalog.pe', 'Lima → Cusco', 42.5, 'en_transito', 'Percy Ccahuana Huillca · V8K-125'],
  ['cliente2@rutalog.pe', 'Lima → Piura', 210, 'en_reparto', 'Lucía Flores Ramos · C5H-903'],
  ['cliente@rutalog.pe', 'Lima → Huancayo', 12, 'entregado', 'Milagros Rojas Pérez · F7R-318'],
  ['cliente2@rutalog.pe', 'Lima → Chiclayo', 95, 'en_transito', 'Hilda Sánchez Paredes · M1N-447'],
  ['cliente@rutalog.pe', 'Lima → Tacna', 330, 'pendiente', null],
  ['cliente2@rutalog.pe', 'Lima → Ica', 27.5, 'entregado', 'Rosa Huamán Torres · BFK-209'],
  ['cliente@rutalog.pe', 'Lima → Puno', 180, 'recogido', 'Yeni Mamani Choque · Z9P-640'],
  ['cliente2@rutalog.pe', 'Lima → Tarapoto', 75, 'en_transito', 'Edwin Tapullima Sangama · U4S-218'],
  ['cliente@rutalog.pe', 'Lima → Pucallpa', 56, 'en_reparto', 'Edwin Tapullima Sangama · U4S-218'],
  ['cliente2@rutalog.pe', 'Lima → Cajamarca', 140, 'pendiente', null],
  ['cliente@rutalog.pe', 'Lima → Ayacucho', 33, 'entregado', 'Jorge Castillo Vega · T2L-771'],
  ['cliente2@rutalog.pe', 'Arequipa → Puno', 88, 'en_transito', 'Carlos Quispe Mamani · AQP-482'],
  ['cliente@rutalog.pe', 'Lima → Iquitos', 24, 'recogido', 'Edwin Tapullima Sangama · U4S-218'],
  ['cliente2@rutalog.pe', 'Lima → Arequipa', 410, 'en_reparto', 'Carlos Quispe Mamani · AQP-482'],
  ['cliente@rutalog.pe', 'Lima → Trujillo', 19.5, 'pendiente', null],
  ['cliente2@rutalog.pe', 'Lima → Cusco', 260, 'entregado', 'Wilber Condori Apaza · X3C-560'],
  ['cliente@rutalog.pe', 'Lima → Piura', 70, 'en_transito', 'Lucía Flores Ramos · C5H-903'],
  ['cliente2@rutalog.pe', 'Lima → Huancayo', 48, 'pendiente', null],
  ['cliente@rutalog.pe', 'Lima → Chiclayo', 125, 'recogido', 'Hilda Sánchez Paredes · M1N-447'],
  ['cliente2@rutalog.pe', 'Lima → Tacna', 36, 'en_transito', 'Yeni Mamani Choque · Z9P-640'],
  ['cliente@rutalog.pe', 'Lima → Ica', 290, 'en_reparto', 'Rosa Huamán Torres · BFK-209'],
  ['cliente2@rutalog.pe', 'Lima → Puno', 14, 'entregado', 'Percy Ccahuana Huillca · V8K-125'],
  ['cliente@rutalog.pe', 'Lima → Tarapoto', 160, 'pendiente', null],
  ['cliente2@rutalog.pe', 'Lima → Pucallpa', 52, 'recogido', 'Hilda Sánchez Paredes · M1N-447'],
  ['cliente@rutalog.pe', 'Lima → Cajamarca', 230, 'en_transito', 'Jorge Castillo Vega · T2L-771'],
  ['cliente2@rutalog.pe', 'Lima → Ayacucho', 66, 'en_reparto', 'Milagros Rojas Pérez · F7R-318'],
  ['cliente@rutalog.pe', 'Arequipa → Puno', 21, 'entregado', 'Carlos Quispe Mamani · AQP-482'],
  ['cliente2@rutalog.pe', 'Lima → Iquitos', 110, 'pendiente', null]
];

// Proyecto final: los transportistas del parcial pasan a ser usuarios con rol courier.
// nombre, placa, zona base. El texto "Nombre · Placa" que ya guardan los envíos se enlaza con cada uno.
const COURIERS = [
  ['Rosa Huamán Torres', 'BFK-209', 'Lima y Callao'],
  ['Jorge Castillo Vega', 'T2L-771', 'Norte'],
  ['Lucía Flores Ramos', 'C5H-903', 'Norte'],
  ['Hilda Sánchez Paredes', 'M1N-447', 'Norte'],
  ['Milagros Rojas Pérez', 'F7R-318', 'Centro'],
  ['Carlos Quispe Mamani', 'AQP-482', 'Sur'],
  ['Wilber Condori Apaza', 'X3C-560', 'Sur'],
  ['Yeni Mamani Choque', 'Z9P-640', 'Sur'],
  ['Edwin Tapullima Sangama', 'U4S-218', 'Oriente'],
  ['Percy Ccahuana Huillca', 'V8K-125', 'Oriente']
];

// Las mismas 5 zonas que muestra la App Admin (CatalogoRutas.zonas), según la región de destino.
const ZONAS = {
  'Lima y Callao': ['Lima', 'Callao'],
  Norte: ['Tumbes', 'Piura', 'Lambayeque', 'La Libertad', 'Cajamarca', 'Áncash'],
  Centro: ['Huánuco', 'Pasco', 'Junín', 'Huancavelica', 'Ayacucho'],
  Sur: ['Ica', 'Apurímac', 'Cusco', 'Arequipa', 'Puno', 'Moquegua', 'Tacna'],
  Oriente: ['Amazonas', 'San Martín', 'Loreto', 'Ucayali', 'Madre de Dios']
};

/**
 * Cambios del proyecto final sobre la base del parcial. Cada versión se aplica una sola vez
 * (tabla migraciones) y solo agrega: no borra columnas ni datos que usen las apps actuales.
 */
const MIGRACIONES = [
  {
    version: 2,
    nombre: 'Proyecto final: roles, couriers, contraentrega, eventos, evidencias, cobros y liquidaciones',
    pasos: [
      'ALTER TABLE usuarios DROP CONSTRAINT IF EXISTS usuarios_rol_check',
      `ALTER TABLE usuarios ADD CONSTRAINT usuarios_rol_check
         CHECK (rol IN ('cliente', 'operador', 'administrador', 'courier'))`,
      'ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS placa TEXT',
      'ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS zona TEXT',
      'ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS capacidad INTEGER NOT NULL DEFAULT 30 CHECK (capacidad > 0)',

      'ALTER TABLE rutas ADD COLUMN IF NOT EXISTS zona TEXT',

      'ALTER TABLE envios DROP CONSTRAINT IF EXISTS envios_estado_check',
      `ALTER TABLE envios ADD CONSTRAINT envios_estado_check
         CHECK (estado IN ('pendiente', 'recogido', 'en_transito', 'en_reparto', 'entregado',
                           'fallido', 'reprogramado', 'devuelto'))`,
      'ALTER TABLE envios ADD COLUMN IF NOT EXISTS courier_id INTEGER REFERENCES usuarios (id)',
      'ALTER TABLE envios ADD COLUMN IF NOT EXISTS destinatario_nombre TEXT',
      'ALTER TABLE envios ADD COLUMN IF NOT EXISTS destinatario_telefono TEXT',
      'ALTER TABLE envios ADD COLUMN IF NOT EXISTS destinatario_direccion TEXT',
      `ALTER TABLE envios ADD COLUMN IF NOT EXISTS monto_contraentrega NUMERIC(12, 2) NOT NULL DEFAULT 0
         CHECK (monto_contraentrega >= 0)`,
      'ALTER TABLE envios ADD COLUMN IF NOT EXISTS intentos INTEGER NOT NULL DEFAULT 0',
      'ALTER TABLE envios ADD COLUMN IF NOT EXISTS creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()',
      'CREATE INDEX IF NOT EXISTS envios_courier_idx ON envios (courier_id)',

      `CREATE TABLE IF NOT EXISTS paradas (
         id         SERIAL PRIMARY KEY,
         courier_id INTEGER NOT NULL REFERENCES usuarios (id),
         envio_id   INTEGER NOT NULL REFERENCES envios (id),
         tipo       TEXT NOT NULL CHECK (tipo IN ('recojo', 'entrega')),
         orden      INTEGER NOT NULL,
         latitud    NUMERIC(9, 6),
         longitud   NUMERIC(9, 6),
         fecha      DATE NOT NULL DEFAULT CURRENT_DATE,
         UNIQUE (envio_id, tipo, fecha)
       )`,
      // RN-06: cada cambio de estado se guarda con la hora real en que ocurrió, aunque llegue tarde.
      `CREATE TABLE IF NOT EXISTS eventos_envio (
         id                UUID PRIMARY KEY,
         envio_id          INTEGER NOT NULL REFERENCES envios (id),
         estado            TEXT NOT NULL,
         fecha_hora_evento TIMESTAMPTZ NOT NULL,
         latitud           NUMERIC(9, 6),
         longitud          NUMERIC(9, 6),
         usuario_id        INTEGER REFERENCES usuarios (id),
         registrado_en     TIMESTAMPTZ NOT NULL DEFAULT NOW()
       )`,
      'CREATE INDEX IF NOT EXISTS eventos_envio_envio_idx ON eventos_envio (envio_id, fecha_hora_evento)',
      // RN-03: sin foto y firma no se cierra una entrega.
      `CREATE TABLE IF NOT EXISTS evidencias (
         id            SERIAL PRIMARY KEY,
         envio_id      INTEGER NOT NULL UNIQUE REFERENCES envios (id),
         foto_url      TEXT NOT NULL,
         firma_url     TEXT NOT NULL,
         recibe_nombre TEXT NOT NULL,
         recibe_dni    CHAR(8) NOT NULL CHECK (recibe_dni ~ '^[0-9]{8}$'),
         fecha_hora    TIMESTAMPTZ NOT NULL,
         latitud       NUMERIC(9, 6),
         longitud      NUMERIC(9, 6)
       )`,
      `CREATE TABLE IF NOT EXISTS liquidaciones (
         id                  SERIAL PRIMARY KEY,
         remitente_id        INTEGER NOT NULL REFERENCES usuarios (id),
         periodo             TEXT NOT NULL,
         recaudado           NUMERIC(12, 2) NOT NULL,
         costo_envios        NUMERIC(12, 2) NOT NULL,
         neto                NUMERIC(12, 2) NOT NULL,
         estado              TEXT NOT NULL DEFAULT 'CALCULADA' CHECK (estado IN ('CALCULADA', 'APROBADA', 'TRANSFERIDA')),
         nro_operacion_banco TEXT,
         aprobada_por        INTEGER REFERENCES usuarios (id),
         creado_en           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         UNIQUE (remitente_id, periodo)
       )`,
      // RN-01 y RN-04: el contraentrega es del remitente y solo se liquida lo que el banco confirmó.
      `CREATE TABLE IF NOT EXISTS cobros (
         id                  UUID PRIMARY KEY,
         envio_id            INTEGER NOT NULL REFERENCES envios (id),
         tipo                TEXT NOT NULL CHECK (tipo IN ('envio', 'contraentrega')),
         monto               NUMERIC(12, 2) NOT NULL CHECK (monto > 0),
         nro_operacion_banco TEXT UNIQUE,
         estado              TEXT NOT NULL DEFAULT 'POR_COBRAR'
                               CHECK (estado IN ('POR_COBRAR', 'PENDIENTE_CONFIRMACION', 'CONFIRMADO', 'LIQUIDADO')),
         comprobante_url     TEXT,
         liquidacion_id      INTEGER REFERENCES liquidaciones (id),
         creado_en           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         confirmado_en       TIMESTAMPTZ
       )`,
      // RN-05: al tercer intento fallido el envío vuelve al remitente.
      `CREATE TABLE IF NOT EXISTS intentos_fallidos (
         id         SERIAL PRIMARY KEY,
         envio_id   INTEGER NOT NULL REFERENCES envios (id),
         numero     INTEGER NOT NULL,
         motivo     TEXT NOT NULL CHECK (motivo IN ('ausente', 'direccion_errada', 'rechazado', 'zona_inaccesible')),
         foto_url   TEXT,
         fecha      TIMESTAMPTZ NOT NULL,
         courier_id INTEGER REFERENCES usuarios (id),
         UNIQUE (envio_id, numero)
       )`,
      // RN-07 y RN-08: solo se comparte la facturación autorizada; el comité decide en la web del banco.
      `CREATE TABLE IF NOT EXISTS solicitudes_credito (
         id                     SERIAL PRIMARY KEY,
         solicitante_id         INTEGER NOT NULL REFERENCES usuarios (id),
         monto                  NUMERIC(12, 2) NOT NULL CHECK (monto > 0),
         plazo_meses            INTEGER NOT NULL CHECK (plazo_meses > 0),
         proposito              TEXT NOT NULL,
         facturacion_autorizada JSONB NOT NULL,
         estado                 TEXT NOT NULL DEFAULT 'ENVIADO'
                                  CHECK (estado IN ('ENVIADO', 'EN_EVALUACION', 'APROBADO', 'RECHAZADO', 'DESEMBOLSADO')),
         codigo_banco           TEXT,
         creado_en              TIMESTAMPTZ NOT NULL DEFAULT NOW()
       )`
    ],
    datos: datosVersion2
  },
  {
    version: 3,
    nombre: 'App Courier: coordenadas de recojo y entrega, archivos (foto, firma) y orden manual de paradas',
    pasos: [
      'ALTER TABLE envios ADD COLUMN IF NOT EXISTS origen_latitud NUMERIC(9, 6)',
      'ALTER TABLE envios ADD COLUMN IF NOT EXISTS origen_longitud NUMERIC(9, 6)',
      'ALTER TABLE envios ADD COLUMN IF NOT EXISTS destino_latitud NUMERIC(9, 6)',
      'ALTER TABLE envios ADD COLUMN IF NOT EXISTS destino_longitud NUMERIC(9, 6)',
      // Fotos y firmas comprimidas por la app (decenas de KB). Se sirven solo a quien puede ver el envío.
      `CREATE TABLE IF NOT EXISTS archivos (
         id         UUID PRIMARY KEY,
         envio_id   INTEGER NOT NULL REFERENCES envios (id),
         tipo       TEXT NOT NULL CHECK (tipo IN ('foto_entrega', 'firma', 'fachada', 'comprobante')),
         mime       TEXT NOT NULL CHECK (mime IN ('image/jpeg', 'image/png')),
         contenido  BYTEA NOT NULL,
         bytes      INTEGER NOT NULL,
         creado_por INTEGER REFERENCES usuarios (id),
         creado_en  TIMESTAMPTZ NOT NULL DEFAULT NOW()
       )`,
      'CREATE INDEX IF NOT EXISTS archivos_envio_idx ON archivos (envio_id)',
      // RF-C02: el courier puede reordenar a mano; se registra que el orden ya no es el de ML-04.
      'ALTER TABLE paradas ADD COLUMN IF NOT EXISTS manual BOOLEAN NOT NULL DEFAULT FALSE'
    ],
    datos: datosVersion3
  },
  {
    version: 4,
    nombre: 'RF-C07: avisos al destinatario (SMS simulado) tras una entrega fallida',
    pasos: [
      `CREATE TABLE IF NOT EXISTS avisos (
         id         SERIAL PRIMARY KEY,
         envio_id   INTEGER NOT NULL REFERENCES envios (id),
         motivo     TEXT NOT NULL CHECK (motivo IN ('entrega_fallida', 'devolucion')),
         canal      TEXT NOT NULL CHECK (canal IN ('sms')),
         destino    TEXT NOT NULL,
         mensaje    TEXT NOT NULL,
         enviado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
       )`,
      'CREATE INDEX IF NOT EXISTS avisos_envio_idx ON avisos (envio_id)'
    ],
    datos: async () => {}
  },
  {
    version: 5,
    nombre: 'Pagos con Banco Andino: núcleo del banco, pago del envío con QR, cobro contraentrega y liquidaciones',
    pasos: [
      ...PASOS_BANCO,
      // Cuenta de Banco Andino donde el remitente recibe su liquidación.
      'ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS cuenta_banco TEXT',
      // RF-R02: los envíos nuevos se pagan con QR; los anteriores a esta versión no lo requieren.
      `ALTER TABLE envios ADD COLUMN IF NOT EXISTS pago_estado TEXT NOT NULL DEFAULT 'NO_REQUERIDO'
         CHECK (pago_estado IN ('NO_REQUERIDO', 'POR_PAGAR', 'PAGADO'))`,
      'ALTER TABLE cobros ADD COLUMN IF NOT EXISTS cobro_banco_id TEXT',
      'ALTER TABLE cobros ADD COLUMN IF NOT EXISTS codigo_qr TEXT',
      'ALTER TABLE cobros ADD COLUMN IF NOT EXISTS motivo_rechazo TEXT',
      'ALTER TABLE cobros DROP CONSTRAINT IF EXISTS cobros_estado_check',
      `ALTER TABLE cobros ADD CONSTRAINT cobros_estado_check
         CHECK (estado IN ('POR_COBRAR', 'PENDIENTE_CONFIRMACION', 'CONFIRMADO', 'RECHAZADO', 'LIQUIDADO'))`,
      'CREATE INDEX IF NOT EXISTS cobros_envio_idx ON cobros (envio_id, tipo)',
      'ALTER TABLE liquidaciones ADD COLUMN IF NOT EXISTS cuenta_destino TEXT',
      'ALTER TABLE liquidaciones ADD COLUMN IF NOT EXISTS cobros_incluidos INTEGER NOT NULL DEFAULT 0',
      'ALTER TABLE liquidaciones ADD COLUMN IF NOT EXISTS transferida_en TIMESTAMPTZ'
    ],
    datos: async (bd) => {
      await datosBanco(bd);
      await bd.query("UPDATE usuarios SET cuenta_banco = '191-2604003-0' WHERE correo = 'cliente@rutalog.pe' AND cuenta_banco IS NULL");
      await bd.query("UPDATE usuarios SET cuenta_banco = '191-2604004-0' WHERE correo = 'cliente2@rutalog.pe' AND cuenta_banco IS NULL");
    }
  },
  {
    version: 6,
    nombre: 'ML-01 (RF-O02): pedir al destinatario que confirme el horario de las entregas con riesgo alto',
    pasos: [
      `ALTER TABLE envios ADD COLUMN IF NOT EXISTS confirmacion_estado TEXT
         CHECK (confirmacion_estado IN ('PEDIDA', 'CONFIRMADA'))`,
      'ALTER TABLE envios ADD COLUMN IF NOT EXISTS confirmacion_pedida_en TIMESTAMPTZ',
      'ALTER TABLE envios ADD COLUMN IF NOT EXISTS confirmado_en TIMESTAMPTZ',
      'ALTER TABLE avisos DROP CONSTRAINT IF EXISTS avisos_motivo_check',
      `ALTER TABLE avisos ADD CONSTRAINT avisos_motivo_check
         CHECK (motivo IN ('entrega_fallida', 'devolucion', 'confirmacion'))`
    ],
    datos: async () => {}
  }
];

/** Coordenadas simuladas para los envíos que ya existían (alrededor de su ciudad de origen y de destino). */
async function datosVersion3(bd) {
  const { rows } = await bd.query(
    'SELECT e.id, e.uuid, e.ruta, r.region FROM envios e JOIN rutas r ON r.nombre = e.ruta'
  );
  for (const fila of rows) {
    const { origen, destino } = coordenadasEnvio(fila.uuid, fila.ruta, fila.region);
    await bd.query(
      `UPDATE envios SET origen_latitud = $1, origen_longitud = $2, destino_latitud = $3, destino_longitud = $4
       WHERE id = $5`,
      [origen.latitud, origen.longitud, destino.latitud, destino.longitud, fila.id]
    );
  }
}

async function datosVersion2(bd) {
  for (const [zona, regiones] of Object.entries(ZONAS)) {
    await bd.query('UPDATE rutas SET zona = $1 WHERE region = ANY($2::text[])', [zona, regiones]);
  }

  const claveDemo = bcrypt.hashSync('1234', 10);
  await bd.query(
    `INSERT INTO usuarios (nombre, correo, clave_hash, rol) VALUES ('Supervisor de Turno', 'supervisor@rutalog.pe', $1, 'operador')
     ON CONFLICT (correo) DO NOTHING`,
    [claveDemo]
  );

  let numero = 0;
  for (const [nombre, placa, zona] of COURIERS) {
    numero += 1;
    const { rows } = await bd.query(
      `INSERT INTO usuarios (nombre, correo, clave_hash, rol, placa, zona) VALUES ($1, $2, $3, 'courier', $4, $5)
       ON CONFLICT (correo) DO UPDATE SET placa = EXCLUDED.placa, zona = EXCLUDED.zona
       RETURNING id`,
      [nombre, `courier${numero}@rutalog.pe`, claveDemo, placa, zona]
    );
    // Los envíos que ya tenían este transportista (texto del parcial) quedan enlazados al courier.
    await bd.query('UPDATE envios SET courier_id = $1 WHERE transportista_asignado = $2', [
      rows[0].id,
      `${nombre} · ${placa}`
    ]);
  }

  // Dos entregas fallidas de ejemplo para la pantalla del operador, solo si siguen en reparto.
  const ejemplos = [
    [11, [['ausente', '2026-11-12T15:20:00-05:00']]],
    [23, [['direccion_errada', '2026-11-11T10:05:00-05:00'], ['ausente', '2026-11-13T16:40:00-05:00']]]
  ];
  for (const [n, intentos] of ejemplos) {
    const { rows } = await bd.query(
      `UPDATE envios SET estado = 'fallido', intentos = $2, version = version + 1, actualizado_en = NOW()
       WHERE uuid = $1 AND estado = 'en_reparto' RETURNING id, courier_id`,
      [uuidAdicional(n), intentos.length]
    );
    if (!rows[0]) continue;
    let i = 0;
    for (const [motivo, fecha] of intentos) {
      i += 1;
      await bd.query(
        `INSERT INTO intentos_fallidos (envio_id, numero, motivo, fecha, courier_id) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT DO NOTHING`,
        [rows[0].id, i, motivo, fecha, rows[0].courier_id]
      );
      await bd.query(
        `INSERT INTO eventos_envio (id, envio_id, estado, fecha_hora_evento, usuario_id)
         VALUES (gen_random_uuid(), $1, 'fallido', $2, $3)`,
        [rows[0].id, fecha, rows[0].courier_id]
      );
    }
  }
}

async function aplicarMigraciones(bd) {
  await bd.query(
    `CREATE TABLE IF NOT EXISTS migraciones (
       version     INTEGER PRIMARY KEY,
       nombre      TEXT NOT NULL,
       aplicada_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
     )`
  );
  const { rows } = await bd.query('SELECT version FROM migraciones');
  const aplicadas = new Set(rows.map((r) => r.version));
  for (const migracion of MIGRACIONES) {
    if (aplicadas.has(migracion.version)) continue;
    for (const sql of migracion.pasos) {
      await bd.query(sql);
    }
    await migracion.datos(bd);
    await bd.query('INSERT INTO migraciones (version, nombre) VALUES ($1, $2)', [migracion.version, migracion.nombre]);
  }
}

/** UUID fijo de cada envío adicional: permite saber si ya se agregó y no repetirlo. */
function uuidAdicional(numero) {
  return `00000000-0000-4000-8000-${String(numero).padStart(12, '0')}`;
}

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
    if (rows[0].total === 0) {
      await insertarDatosBase(bd);
    }
    await agregarEnviosAdicionales(bd);
    await aplicarMigraciones(bd);
  });
}

/** Usuarios, rutas y los 10 primeros envíos: solo en una base recién creada. */
async function insertarDatosBase(bd) {
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
}

/**
 * Agrega los 30 envíos adicionales si todavía no están. Usa guías de la serie 300001–300030,
 * que no chocan con las que generan las apps, y no modifica ningún envío existente.
 */
async function agregarEnviosAdicionales(bd) {
  const ultimo = uuidAdicional(ENVIOS_ADICIONALES.length);
  const yaEstan = await bd.query('SELECT 1 FROM envios WHERE uuid = $1', [ultimo]);
  if (yaEstan.rows.length > 0) return;

  const fechaGuia = new Date(2026, 0, 1);
  let numero = 0;
  for (const [correo, ruta, peso, estado, transportista] of ENVIOS_ADICIONALES) {
    numero += 1;
    await bd.query(
      `INSERT INTO envios (uuid, numero_guia, ruta, peso_kg, costo_envio, estado, transportista_asignado, usuario_id)
       SELECT $1::uuid, $2::text, r.nombre, $3::numeric,
              ROUND($3::numeric * r.tarifa_por_kg, 2), $4::text, $5::text, u.id
       FROM rutas r, usuarios u
       WHERE r.nombre = $6::text AND u.correo = $7::text
       ON CONFLICT DO NOTHING`,
      [uuidAdicional(numero), generarGuia(300000 + numero, fechaGuia), peso, estado, transportista, ruta, correo]
    );
  }
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

module.exports = {
  asegurarEsquema,
  generarGuia,
  ENVIOS,
  ENVIOS_ADICIONALES,
  RUTAS,
  USUARIOS,
  COURIERS,
  ZONAS,
  MIGRACIONES
};
