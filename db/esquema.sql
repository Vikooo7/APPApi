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
