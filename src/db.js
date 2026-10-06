const { Pool } = require('pg');

// Vercel crea DATABASE_URL al conectar la base Neon con el proyecto.
const cadena =
  process.env.DATABASE_URL ||
  process.env.POSTGRES_URL ||
  process.env.STORAGE_URL ||
  process.env.STORAGE_DATABASE_URL;

let pool;

function obtenerPool() {
  if (!pool) {
    if (!cadena) {
      const error = new Error('Falta la variable DATABASE_URL: conecta la base Neon al proyecto en Vercel.');
      error.estado = 500;
      throw error;
    }
    pool = new Pool({
      connectionString: cadena,
      // Neon exige SSL; si la cadena no lo indica, se activa aquí.
      ssl: /sslmode=/.test(cadena) ? undefined : true,
      max: 3
    });
  }
  return pool;
}

function consulta(texto, parametros) {
  return obtenerPool().query(texto, parametros);
}

/** Ejecuta fn dentro de una transacción: si algo falla, no se guarda nada. */
async function transaccion(fn) {
  const cliente = await obtenerPool().connect();
  try {
    await cliente.query('BEGIN');
    const resultado = await fn(cliente);
    await cliente.query('COMMIT');
    return resultado;
  } catch (error) {
    await cliente.query('ROLLBACK');
    throw error;
  } finally {
    cliente.release();
  }
}

module.exports = { consulta, transaccion, cadena };
