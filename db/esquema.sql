-- Esquema de la base remota de RutaLog Perú (PostgreSQL en Neon).
-- La API crea estas tablas sola la primera vez que se usa (src/esquema.js);
-- este archivo es la versión para el documento y para ejecutarla a mano si hiciera falta.

CREATE TABLE IF NOT EXISTS usuarios (
    id          SERIAL PRIMARY KEY,
    nombre      TEXT NOT NULL,
    correo      TEXT NOT NULL UNIQUE,
    clave_hash  TEXT NOT NULL,              -- hash bcrypt; nunca la clave en texto plano
    rol         TEXT NOT NULL CHECK (rol IN ('cliente', 'administrador'))
);

CREATE TABLE IF NOT EXISTS rutas (
    id              SERIAL PRIMARY KEY,
    nombre          TEXT NOT NULL UNIQUE,   -- ej.: 'Lima → Arequipa'
    tiempo_estimado INTEGER NOT NULL,       -- horas de viaje
    tarifa_por_kg   NUMERIC(8, 2) NOT NULL, -- S/ por kg (RF08)
    region          TEXT NOT NULL,
    activa          BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS envios (
    id                     SERIAL PRIMARY KEY,          -- identificador remoto
    uuid                   UUID NOT NULL UNIQUE,        -- lo genera la app al crear el envío
    numero_guia            TEXT NOT NULL UNIQUE,
    ruta                   TEXT NOT NULL,
    peso_kg                NUMERIC(10, 2) NOT NULL CHECK (peso_kg > 0),
    costo_envio            NUMERIC(12, 2) NOT NULL,     -- peso_kg × tarifa_por_kg, calculado por la API
    estado                 TEXT NOT NULL DEFAULT 'pendiente'
                             CHECK (estado IN ('pendiente', 'recogido', 'en_transito', 'en_reparto', 'entregado')),
    transportista_asignado TEXT,
    usuario_id             INTEGER NOT NULL REFERENCES usuarios (id),
    version                INTEGER NOT NULL DEFAULT 1,  -- aumenta con cada cambio; detecta conflictos
    eliminado              BOOLEAN NOT NULL DEFAULT FALSE,
    actualizado_en         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- RF15: cada escritura llega con un UUID de operación. Si el mismo UUID llega otra vez
-- (por un reintento de la app), la API devuelve la respuesta guardada y no repite el cambio.
CREATE TABLE IF NOT EXISTS operaciones_procesadas (
    uuid_operacion UUID PRIMARY KEY,
    usuario_id     INTEGER NOT NULL REFERENCES usuarios (id),
    tipo           TEXT NOT NULL,           -- CREAR, ACTUALIZAR o ELIMINAR
    id_envio       INTEGER,
    estado_http    INTEGER NOT NULL,
    respuesta      JSONB NOT NULL,
    fecha          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Proyecto final (versión 2). La API la aplica una sola vez y la anota en la tabla migraciones.
CREATE TABLE IF NOT EXISTS migraciones (
    version     INTEGER PRIMARY KEY,
    nombre      TEXT NOT NULL,
    aplicada_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE usuarios DROP CONSTRAINT IF EXISTS usuarios_rol_check;

ALTER TABLE usuarios ADD CONSTRAINT usuarios_rol_check
  CHECK (rol IN ('cliente', 'operador', 'administrador', 'courier'));

ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS placa TEXT;

ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS zona TEXT;

ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS capacidad INTEGER NOT NULL DEFAULT 30 CHECK (capacidad > 0);

ALTER TABLE rutas ADD COLUMN IF NOT EXISTS zona TEXT;

ALTER TABLE envios DROP CONSTRAINT IF EXISTS envios_estado_check;

ALTER TABLE envios ADD CONSTRAINT envios_estado_check
  CHECK (estado IN ('pendiente', 'recogido', 'en_transito', 'en_reparto', 'entregado',
                    'fallido', 'reprogramado', 'devuelto'));

ALTER TABLE envios ADD COLUMN IF NOT EXISTS courier_id INTEGER REFERENCES usuarios (id);

ALTER TABLE envios ADD COLUMN IF NOT EXISTS destinatario_nombre TEXT;

ALTER TABLE envios ADD COLUMN IF NOT EXISTS destinatario_telefono TEXT;

ALTER TABLE envios ADD COLUMN IF NOT EXISTS destinatario_direccion TEXT;

ALTER TABLE envios ADD COLUMN IF NOT EXISTS monto_contraentrega NUMERIC(12, 2) NOT NULL DEFAULT 0
  CHECK (monto_contraentrega >= 0);

ALTER TABLE envios ADD COLUMN IF NOT EXISTS intentos INTEGER NOT NULL DEFAULT 0;

ALTER TABLE envios ADD COLUMN IF NOT EXISTS creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX IF NOT EXISTS envios_courier_idx ON envios (courier_id);

CREATE TABLE IF NOT EXISTS paradas (
  id         SERIAL PRIMARY KEY,
  courier_id INTEGER NOT NULL REFERENCES usuarios (id),
  envio_id   INTEGER NOT NULL REFERENCES envios (id),
  tipo       TEXT NOT NULL CHECK (tipo IN ('recojo', 'entrega')),
  orden      INTEGER NOT NULL,
  latitud    NUMERIC(9, 6),
  longitud   NUMERIC(9, 6),
  fecha      DATE NOT NULL DEFAULT CURRENT_DATE,
  UNIQUE (envio_id, tipo, fecha)
);

CREATE TABLE IF NOT EXISTS eventos_envio (
  id                UUID PRIMARY KEY,
  envio_id          INTEGER NOT NULL REFERENCES envios (id),
  estado            TEXT NOT NULL,
  fecha_hora_evento TIMESTAMPTZ NOT NULL,
  latitud           NUMERIC(9, 6),
  longitud          NUMERIC(9, 6),
  usuario_id        INTEGER REFERENCES usuarios (id),
  registrado_en     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS eventos_envio_envio_idx ON eventos_envio (envio_id, fecha_hora_evento);

CREATE TABLE IF NOT EXISTS evidencias (
  id            SERIAL PRIMARY KEY,
  envio_id      INTEGER NOT NULL UNIQUE REFERENCES envios (id),
  foto_url      TEXT NOT NULL,
  firma_url     TEXT NOT NULL,
  recibe_nombre TEXT NOT NULL,
  recibe_dni    CHAR(8) NOT NULL CHECK (recibe_dni ~ '^[0-9]{8}$'),
  fecha_hora    TIMESTAMPTZ NOT NULL,
  latitud       NUMERIC(9, 6),
  longitud      NUMERIC(9, 6)
);

CREATE TABLE IF NOT EXISTS liquidaciones (
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
);

CREATE TABLE IF NOT EXISTS cobros (
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
);

CREATE TABLE IF NOT EXISTS intentos_fallidos (
  id         SERIAL PRIMARY KEY,
  envio_id   INTEGER NOT NULL REFERENCES envios (id),
  numero     INTEGER NOT NULL,
  motivo     TEXT NOT NULL CHECK (motivo IN ('ausente', 'direccion_errada', 'rechazado', 'zona_inaccesible')),
  foto_url   TEXT,
  fecha      TIMESTAMPTZ NOT NULL,
  courier_id INTEGER REFERENCES usuarios (id),
  UNIQUE (envio_id, numero)
);

CREATE TABLE IF NOT EXISTS solicitudes_credito (
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
);

-- App Courier (versión 3): coordenadas de recojo y entrega, imágenes (foto y firma) y orden manual de paradas.

ALTER TABLE envios ADD COLUMN IF NOT EXISTS origen_latitud NUMERIC(9, 6);

ALTER TABLE envios ADD COLUMN IF NOT EXISTS origen_longitud NUMERIC(9, 6);

ALTER TABLE envios ADD COLUMN IF NOT EXISTS destino_latitud NUMERIC(9, 6);

ALTER TABLE envios ADD COLUMN IF NOT EXISTS destino_longitud NUMERIC(9, 6);

CREATE TABLE IF NOT EXISTS archivos (
  id         UUID PRIMARY KEY,
  envio_id   INTEGER NOT NULL REFERENCES envios (id),
  tipo       TEXT NOT NULL CHECK (tipo IN ('foto_entrega', 'firma', 'fachada', 'comprobante')),
  mime       TEXT NOT NULL CHECK (mime IN ('image/jpeg', 'image/png')),
  contenido  BYTEA NOT NULL,
  bytes      INTEGER NOT NULL,
  creado_por INTEGER REFERENCES usuarios (id),
  creado_en  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS archivos_envio_idx ON archivos (envio_id);

ALTER TABLE paradas ADD COLUMN IF NOT EXISTS manual BOOLEAN NOT NULL DEFAULT FALSE;

-- RF-C07 (versión 4): aviso al destinatario tras una entrega fallida. El SMS es simulado:
-- se registra qué se envió, a qué número (enmascarado) y cuándo; el remitente lo ve en el seguimiento.
CREATE TABLE IF NOT EXISTS avisos (
    id         SERIAL PRIMARY KEY,
    envio_id   INTEGER NOT NULL REFERENCES envios (id),
    motivo     TEXT NOT NULL CHECK (motivo IN ('entrega_fallida', 'devolucion')),
    canal      TEXT NOT NULL CHECK (canal IN ('sms')),
    destino    TEXT NOT NULL,
    mensaje    TEXT NOT NULL,
    enviado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS avisos_envio_idx ON avisos (envio_id);
