// Cliente HTTP de Banco Andino. RutaLog habla con el banco SOLO por aquí, como con cualquier servidor externo:
// las apps nunca llaman al banco y la clave del banco nunca sale del servidor (RNF-04).
//
// BANCO_URL: dirección del banco. Si no se define, se usa este mismo despliegue (/banco/api), donde corre
// el núcleo simulado. Si el docente entrega su propio núcleo, basta con definir BANCO_URL y BANCO_CLAVE_API.
const { CLAVE_SERVIDOR } = require('./banco/rutas');

function error(estado, codigo, mensaje) {
  const e = new Error(mensaje);
  e.estado = estado;
  e.codigo = codigo;
  return e;
}

const TIEMPO_MAXIMO_MS = 15000;

function crearClienteBanco(req) {
  const base = (process.env.BANCO_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');

  async function llamar(metodo, ruta, cuerpo) {
    let respuesta;
    try {
      respuesta = await fetch(`${base}/banco/api${ruta}`, {
        method: metodo,
        headers: { 'content-type': 'application/json', 'x-banco-clave': CLAVE_SERVIDOR },
        body: cuerpo ? JSON.stringify(cuerpo) : undefined,
        signal: AbortSignal.timeout(TIEMPO_MAXIMO_MS)
      });
    } catch (e) {
      throw error(503, 'BANCO_NO_DISPONIBLE', 'Banco Andino no responde. Intenta de nuevo en un momento.');
    }
    const datos = await respuesta.json().catch(() => ({}));
    if (!respuesta.ok) {
      // Los rechazos del banco (saldo insuficiente, QR vencido...) se reenvían con su código; las caídas, como 502.
      const e = error(respuesta.status >= 500 ? 502 : respuesta.status, datos.codigo || 'BANCO_ERROR', datos.mensaje || 'Banco Andino rechazó la operación.');
      e.desdeBanco = true;
      throw e;
    }
    return datos;
  }

  return {
    crearCobroQr: (datos) => llamar('POST', '/cobros-qr', datos),
    consultarCobro: (id) => llamar('GET', `/cobros-qr/${encodeURIComponent(id)}`),
    verificarOperacion: (nro) => llamar('GET', `/transferencias/${encodeURIComponent(nro)}`),
    transferirLote: (datos) => llamar('POST', '/transferencias/lote', datos),
    consultarCuenta: (numero) => llamar('GET', `/cuentas/${encodeURIComponent(numero)}`),
    solicitarCredito: (datos) => llamar('POST', '/creditos', datos),
    consultarCredito: (id) => llamar('GET', `/creditos/${encodeURIComponent(id)}`)
  };
}

module.exports = { crearClienteBanco };
