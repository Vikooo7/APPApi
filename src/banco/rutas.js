// Endpoints de Banco Andino (/banco/api/...). Tres tipos de acceso, separados de RutaLog:
//  - Servidores (RutaLog): encabezado x-banco-clave. Las apps de RutaLog nunca llaman al banco.
//  - Clientes del banco (app Banco Andino): su propio inicio de sesión y su propio token.
//  - Comité de créditos: encabezado x-comite-clave (la web /banco/comite).
const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { consulta, transaccion, cadena } = require('../db');
const nucleo = require('./nucleo');
const { PAGINA_COMITE } = require('./comite');

const { error } = nucleo;

// Claves propias del banco. Si no se definen en Vercel, se derivan de la cadena de conexión (secreta y solo
// en el servidor); RutaLog usa la misma derivación para llamarlo cuando ambos corren en el mismo despliegue.
const derivar = (etiqueta) => crypto.createHash('sha256').update(`${etiqueta}:${cadena || 'local'}`).digest('hex');
const CLAVE_SERVIDOR = process.env.BANCO_CLAVE_API || derivar('banco-servidor');
const SECRETO_CLIENTES = process.env.BANCO_JWT_SECRET || derivar('banco-clientes');
// Clave de la web del comité (simulada). En Vercel se recomienda definir BANCO_COMITE_CLAVE.
const CLAVE_COMITE = process.env.BANCO_COMITE_CLAVE || 'comite2026';

function igualSeguro(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function soloServidor(req, res, next) {
  if (!igualSeguro(req.get('x-banco-clave'), CLAVE_SERVIDOR)) {
    return next(error(401, 'BANCO_CLAVE_INVALIDA', 'Clave de servidor de Banco Andino inválida.'));
  }
  next();
}

function soloCliente(req, res, next) {
  const encabezado = req.get('authorization') || '';
  const token = encabezado.startsWith('Bearer ') ? encabezado.slice(7) : null;
  if (!token) return next(error(401, 'SIN_SESION', 'Inicia sesión en Banco Andino.'));
  try {
    req.clienteBanco = jwt.verify(token, SECRETO_CLIENTES, { audience: 'banco-andino' });
    next();
  } catch (e) {
    next(error(401, 'SESION_VENCIDA', 'Tu sesión de Banco Andino venció. Vuelve a ingresar.'));
  }
}

function soloComite(req, res, next) {
  if (!igualSeguro(req.get('x-comite-clave'), CLAVE_COMITE)) {
    return next(error(401, 'COMITE_CLAVE_INVALIDA', 'Clave del comité incorrecta.'));
  }
  next();
}

/** Atajo: ejecuta fn en una transacción y responde con su resultado. */
const manejar = (estado, fn) => async (req, res, next) => {
  try {
    res.status(estado).json(await transaccion((bd) => fn(bd, req)));
  } catch (e) {
    next(e);
  }
};

const rutasBanco = express.Router();

// ---------- Servidores (RutaLog) ----------

/** POST /banco/api/cobros-qr { monto, concepto, referencia, venceEnMin } → cobro con su código QR. */
rutasBanco.post('/api/cobros-qr', soloServidor, manejar(201, (bd, req) => nucleo.crearCobroQr(bd, req.body || {})));

/** GET /banco/api/cobros-qr/:id → estado del cobro (PENDIENTE, PAGADO, VENCIDO, ANULADO). */
rutasBanco.get('/api/cobros-qr/:id', soloServidor, manejar(200, (bd, req) => nucleo.obtenerCobro(bd, req.params.id)));

/** GET /banco/api/transferencias/:nro → verifica una operación (RNF-05). */
rutasBanco.get('/api/transferencias/:nro', soloServidor, manejar(200, (bd, req) => nucleo.obtenerOperacion(bd, req.params.nro)));

/** POST /banco/api/transferencias/lote { uuid, transferencias: [{ cuentaDestino, monto, concepto, referencia }] } */
rutasBanco.post(
  '/api/transferencias/lote',
  soloServidor,
  manejar(201, (bd, req) => nucleo.transferirLote(bd, { transferencias: req.body?.transferencias, uuid: req.body?.uuid }))
);

/** GET /banco/api/cuentas/:numero → si la cuenta existe y su titular (para registrar la cuenta del remitente). */
rutasBanco.get('/api/cuentas/:numero', soloServidor, manejar(200, (bd, req) => nucleo.cuentaExiste(bd, req.params.numero)));

/** POST /banco/api/creditos { solicitante, monto, plazoMeses, proposito, facturacion: [{ mes, facturacion, envios }] } */
rutasBanco.post('/api/creditos', soloServidor, manejar(201, (bd, req) => nucleo.solicitarCredito(bd, req.body || {})));

/** GET /banco/api/creditos/:id → estado, cuota y cronograma. */
rutasBanco.get('/api/creditos/:id', soloServidor, manejar(200, (bd, req) => nucleo.obtenerCredito(bd, req.params.id)));

// ---------- Clientes del banco (app Banco Andino) ----------

/** POST /banco/api/clientes/login { usuario, clave } → { token, cliente } */
rutasBanco.post('/api/clientes/login', async (req, res, next) => {
  try {
    const usuario = String(req.body?.usuario || '').trim().toLowerCase();
    const clave = String(req.body?.clave || '');
    if (!usuario || !clave) throw error(400, 'DATOS_INCOMPLETOS', 'Ingresa tu usuario y tu clave.');
    const { rows } = await consulta('SELECT id, usuario, nombre, clave_hash FROM banco_clientes WHERE usuario = $1', [usuario]);
    if (!rows[0] || !bcrypt.compareSync(clave, rows[0].clave_hash)) {
      throw error(401, 'CREDENCIALES_INVALIDAS', 'Usuario o clave incorrectos.');
    }
    const cliente = { id: rows[0].id, usuario: rows[0].usuario, nombre: rows[0].nombre };
    const token = jwt.sign(cliente, SECRETO_CLIENTES, { expiresIn: '12h', audience: 'banco-andino' });
    res.json({ token, cliente: { usuario: cliente.usuario, nombre: cliente.nombre } });
  } catch (e) {
    next(e);
  }
});

/** GET /banco/api/clientes/yo → cuentas con saldo y últimos movimientos. */
rutasBanco.get('/api/clientes/yo', soloCliente, manejar(200, (bd, req) => nucleo.resumenCliente(bd, req.clienteBanco.id)));

/** GET /banco/api/qr/:codigo → qué se va a pagar (comercio, monto, concepto), antes de confirmar. */
rutasBanco.get('/api/qr/:codigo', soloCliente, manejar(200, (bd, req) => nucleo.obtenerCobro(bd, req.params.codigo)));

/** POST /banco/api/qr/:codigo/pagar { uuid } → { nroOperacion, monto, saldo } */
rutasBanco.post(
  '/api/qr/:codigo/pagar',
  soloCliente,
  manejar(201, (bd, req) => nucleo.pagarCobro(bd, { codigo: req.params.codigo, clienteId: req.clienteBanco.id, uuid: req.body?.uuid }))
);

// ---------- Comité de créditos (web) ----------

// La página va en un módulo .js (no en un .html suelto) para que Vercel siempre la incluya en el despliegue.
rutasBanco.get('/comite', (req, res) => res.type('html').send(PAGINA_COMITE));

rutasBanco.get('/api/comite/creditos', soloComite, manejar(200, (bd) => nucleo.listarCreditos(bd)));

/** POST /banco/api/comite/creditos/:id { decision: APROBADO | RECHAZADO, comentario } */
rutasBanco.post(
  '/api/comite/creditos/:id',
  soloComite,
  manejar(200, (bd, req) => nucleo.decidirCredito(bd, req.params.id, { decision: req.body?.decision, comentario: req.body?.comentario }))
);

module.exports = { rutasBanco, CLAVE_SERVIDOR };
