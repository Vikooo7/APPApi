// Datos de ejemplo de Banco Andino (todos simulados). Las claves de la billetera son de prueba.
const bcrypt = require('bcryptjs');
const { CUENTA_RUTALOG } = require('./nucleo');

const PASOS_BANCO = [
  `CREATE SEQUENCE IF NOT EXISTS banco_nro_seq START 44101`,
  `CREATE SEQUENCE IF NOT EXISTS banco_credito_seq START 71`,
  `CREATE TABLE IF NOT EXISTS banco_clientes (
     id         SERIAL PRIMARY KEY,
     usuario    TEXT NOT NULL UNIQUE,
     nombre     TEXT NOT NULL,
     clave_hash TEXT NOT NULL,
     creado_en  TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,
  `CREATE TABLE IF NOT EXISTS banco_cuentas (
     numero     TEXT PRIMARY KEY,
     cliente_id INTEGER REFERENCES banco_clientes (id),
     titular    TEXT NOT NULL,
     tipo       TEXT NOT NULL CHECK (tipo IN ('personal', 'empresa')),
     saldo      NUMERIC(14, 2) NOT NULL DEFAULT 0 CHECK (saldo >= 0),
     creado_en  TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,
  `CREATE TABLE IF NOT EXISTS banco_operaciones (
     nro            TEXT PRIMARY KEY,
     tipo           TEXT NOT NULL CHECK (tipo IN ('PAGO_QR', 'TRANSFERENCIA', 'DESEMBOLSO', 'DEPOSITO')),
     cuenta_origen  TEXT REFERENCES banco_cuentas (numero),
     cuenta_destino TEXT NOT NULL REFERENCES banco_cuentas (numero),
     monto          NUMERIC(14, 2) NOT NULL CHECK (monto > 0),
     concepto       TEXT NOT NULL,
     referencia     TEXT,
     uuid           UUID UNIQUE,
     fecha          TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,
  `CREATE TABLE IF NOT EXISTS banco_movimientos (
     id            SERIAL PRIMARY KEY,
     cuenta        TEXT NOT NULL REFERENCES banco_cuentas (numero),
     nro_operacion TEXT REFERENCES banco_operaciones (nro),
     descripcion   TEXT NOT NULL,
     monto         NUMERIC(14, 2) NOT NULL,
     saldo         NUMERIC(14, 2) NOT NULL,
     fecha         TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,
  'CREATE INDEX IF NOT EXISTS banco_movimientos_cuenta_idx ON banco_movimientos (cuenta, fecha DESC)',
  `CREATE TABLE IF NOT EXISTS banco_cobros_qr (
     id              TEXT PRIMARY KEY,
     cuenta_comercio TEXT NOT NULL REFERENCES banco_cuentas (numero),
     monto           NUMERIC(14, 2) NOT NULL CHECK (monto > 0),
     concepto        TEXT NOT NULL,
     referencia      TEXT,
     estado          TEXT NOT NULL DEFAULT 'PENDIENTE' CHECK (estado IN ('PENDIENTE', 'PAGADO', 'ANULADO')),
     nro_operacion   TEXT REFERENCES banco_operaciones (nro),
     creado_en       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     vence_en        TIMESTAMPTZ NOT NULL,
     pagado_en       TIMESTAMPTZ
   )`,
  `CREATE TABLE IF NOT EXISTS banco_lotes (
     uuid       UUID PRIMARY KEY,
     resultados JSONB NOT NULL,
     creado_en  TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,
  `CREATE TABLE IF NOT EXISTS banco_creditos (
     id             TEXT PRIMARY KEY,
     cuenta         TEXT NOT NULL REFERENCES banco_cuentas (numero),
     solicitante    TEXT NOT NULL,
     monto          NUMERIC(14, 2) NOT NULL CHECK (monto > 0),
     plazo_meses    INTEGER NOT NULL CHECK (plazo_meses BETWEEN 6 AND 84),
     tasa_anual     NUMERIC(6, 4) NOT NULL,
     proposito      TEXT NOT NULL,
     facturacion    JSONB NOT NULL,
     estado         TEXT NOT NULL DEFAULT 'EN_EVALUACION' CHECK (estado IN ('EN_EVALUACION', 'RECHAZADO', 'DESEMBOLSADO')),
     comentario     TEXT,
     nro_desembolso TEXT REFERENCES banco_operaciones (nro),
     creado_en      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     decidido_en    TIMESTAMPTZ
   )`
];

// usuario de la billetera, nombre, cuenta, tipo, saldo inicial. Clave de todas: banco2026.
const CLIENTES_BANCO = [
  // Cuenta del reto de la Semana 2 (el destinatario de la prueba de la ficha).
  ['cliente1', 'Carlos Mendoza', '191-2604001-0', 'personal', 3450],
  ['lucia', 'Lucía Paredes Quispe', '191-2604002-0', 'personal', 1200],
  // Remitentes de RutaLog: aquí reciben su liquidación.
  ['andina', 'Distribuidora Andina SAC', '191-2604003-0', 'empresa', 5000],
  ['gamarra', 'Textiles Gamarra EIRL', '191-2604004-0', 'empresa', 2500],
  // RutaLog: cuenta de recaudo (recibe los pagos QR y paga las liquidaciones).
  ['rutalog', 'RutaLog Perú SAC', CUENTA_RUTALOG, 'empresa', 30000]
];

// Los 6 movimientos del reto de la Semana 2, ahora con su número de operación.
const MOVIMIENTOS_SEMANA2 = [
  ['2026-08-10', 'Pago de tarjeta de crédito', -450.0],
  ['2026-08-12', 'Retiro cajero automático', -200.0],
  ['2026-08-15', 'Transferencia recibida', 300.0],
  ['2026-08-17', 'Compra - Supermercado', -120.3],
  ['2026-08-19', 'Depósito en agencia', 500.0],
  ['2026-08-20', 'Pago de servicios - Luz', -85.5]
];

async function datosBanco(bd) {
  const clave = bcrypt.hashSync('banco2026', 10);
  for (const [usuario, nombre, numero, tipo, saldo] of CLIENTES_BANCO) {
    const { rows } = await bd.query(
      `INSERT INTO banco_clientes (usuario, nombre, clave_hash) VALUES ($1, $2, $3)
       ON CONFLICT (usuario) DO UPDATE SET nombre = EXCLUDED.nombre RETURNING id`,
      [usuario, nombre, clave]
    );
    await bd.query(
      `INSERT INTO banco_cuentas (numero, cliente_id, titular, tipo, saldo) VALUES ($1, $2, $3, $4, 0)
       ON CONFLICT (numero) DO NOTHING`,
      [numero, rows[0].id, nombre, tipo]
    );
    // Saldo inicial como depósito, para que el movimiento quede registrado igual que en un banco real.
    const saldoInicial = usuario === 'cliente1' ? saldo - MOVIMIENTOS_SEMANA2.reduce((s, m) => s + m[2], 0) : saldo;
    await depositar(bd, numero, saldoInicial, 'Saldo inicial', '2026-08-01');
  }
  let saldo = 3450 - MOVIMIENTOS_SEMANA2.reduce((s, m) => s + m[2], 0);
  for (const [fecha, descripcion, monto] of MOVIMIENTOS_SEMANA2) {
    saldo = Math.round((saldo + monto) * 100) / 100;
    // Movimientos con terceros de fuera del banco (luz, supermercado): solo quedan en el extracto del cliente.
    await bd.query(
      'INSERT INTO banco_movimientos (cuenta, nro_operacion, descripcion, monto, saldo, fecha) VALUES ($1, NULL, $2, $3, $4, $5)',
      ['191-2604001-0', descripcion, monto, saldo, `${fecha}T12:00:00Z`]
    );
  }
  await bd.query("UPDATE banco_cuentas SET saldo = 3450 WHERE numero = '191-2604001-0'");
}

async function depositar(bd, numero, monto, descripcion, fecha) {
  const { rows } = await bd.query("SELECT 'BA-' || nextval('banco_nro_seq') AS nro");
  await bd.query(
    `INSERT INTO banco_operaciones (nro, tipo, cuenta_origen, cuenta_destino, monto, concepto, fecha)
     VALUES ($1, 'DEPOSITO', NULL, $2, $3, $4, $5)`,
    [rows[0].nro, numero, monto, descripcion, `${fecha}T09:00:00Z`]
  );
  const { rows: c } = await bd.query('UPDATE banco_cuentas SET saldo = saldo + $1 WHERE numero = $2 RETURNING saldo', [monto, numero]);
  await bd.query(
    'INSERT INTO banco_movimientos (cuenta, nro_operacion, descripcion, monto, saldo, fecha) VALUES ($1, $2, $3, $4, $5, $6)',
    [numero, rows[0].nro, descripcion, monto, c[0].saldo, `${fecha}T09:00:00Z`]
  );
}

module.exports = { PASOS_BANCO, datosBanco, CLIENTES_BANCO };
