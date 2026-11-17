// Ayuda para las pruebas: desde la versión 5 un envío nuevo se paga con QR antes de asignarlo (RF-R02).
// Hace lo mismo que el remitente: pide el QR en RutaLog, lo paga con su billetera de Banco Andino y RutaLog lo verifica.
const CUENTA_BANCO = { 'cliente@rutalog.pe': 'andina', 'cliente2@rutalog.pe': 'gamarra' };

async function pagarEnvio(api, tokenCliente, envio, correoCliente = 'cliente@rutalog.pe') {
  const pedir = async (base, metodo, ruta, token, cuerpo) => {
    const r = await fetch(base + ruta, {
      method: metodo,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: cuerpo ? JSON.stringify(cuerpo) : undefined
    });
    return { http: r.status, datos: await r.json().catch(() => null) };
  };
  const banco = api.replace(/\/api$/, '') + '/banco/api';
  const qr = await pedir(api, 'POST', '/pagos/qr', tokenCliente, { envioId: envio.id, tipo: 'envio' });
  if (qr.http !== 201) throw new Error(`No se pudo pedir el QR de ${envio.numeroGuia}: ${JSON.stringify(qr.datos)}`);
  const login = await pedir(banco, 'POST', '/clientes/login', null, { usuario: CUENTA_BANCO[correoCliente], clave: 'banco2026' });
  const pago = await pedir(banco, 'POST', `/qr/${encodeURIComponent(qr.datos.codigoQr)}/pagar`, login.datos.token, { uuid: crypto.randomUUID() });
  if (pago.http !== 201) throw new Error(`No se pudo pagar ${envio.numeroGuia}: ${JSON.stringify(pago.datos)}`);
  const estado = await pedir(api, 'GET', `/pagos/${qr.datos.id}`, tokenCliente);
  if (estado.datos?.estado !== 'CONFIRMADO') throw new Error(`El pago de ${envio.numeroGuia} no se confirmó: ${JSON.stringify(estado.datos)}`);
}

module.exports = { pagarEnvio };
