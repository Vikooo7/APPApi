// Prueba de punta a punta de ML-01 en la API (RF-O02, HU-O01), contra una API local conectada a una COPIA de la base.
// Uso: node --env-file=.env servidor-local.js   (en otra terminal)
//      node pruebas/probar-riesgo.js [http://localhost:3000/api]

const API = process.argv[2] || 'http://localhost:3000/api';
let pasos = 0;
let fallos = 0;

async function llamar(metodo, ruta, token, cuerpo) {
  const r = await fetch(API + ruta, {
    method: metodo,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: cuerpo ? JSON.stringify(cuerpo) : undefined
  });
  return { http: r.status, datos: await r.json().catch(() => null) };
}

function comprobar(descripcion, condicion, detalle) {
  pasos += 1;
  if (condicion) console.log(`  ✔ ${descripcion}`);
  else {
    fallos += 1;
    console.log(`  ✖ ${descripcion}`, detalle !== undefined ? JSON.stringify(detalle) : '');
  }
}

async function entrar(correo) {
  const r = await llamar('POST', '/auth/login', null, { correo, clave: '1234' });
  if (r.http !== 200) throw new Error(`No se pudo entrar como ${correo}`);
  return r.datos.token;
}

(async () => {
  console.log(`API: ${API}`);
  const operador = await entrar('supervisor@rutalog.pe');
  const cliente = await entrar('cliente@rutalog.pe');
  const courier = await entrar('courier1@rutalog.pe');

  console.log('Permisos');
  comprobar('el remitente no ve el riesgo (403)', (await llamar('GET', '/ml/riesgo-fallida', cliente)).http === 403);
  comprobar('el courier tampoco (403)', (await llamar('GET', '/ml/riesgo-fallida', courier)).http === 403);
  comprobar('una fecha mal escrita se rechaza (422)', (await llamar('GET', '/ml/riesgo-fallida?fecha=19-11-2026', operador)).http === 422);

  console.log('Riesgo por entrega (ML-01)');
  const r = await llamar('GET', '/ml/riesgo-fallida?fecha=2026-11-21', operador);
  comprobar('la operación ve el riesgo de cada entrega con el modelo y su umbral', r.http === 200 && r.datos.fecha === '2026-11-21' && r.datos.modelo.umbralRiesgoAlto > 0, r.datos?.modelo);
  const lista = r.datos.datos;
  comprobar('vienen ordenadas de mayor a menor probabilidad', lista.every((d, i) => i === 0 || lista[i - 1].probabilidad >= d.probabilidad));
  comprobar('riesgo alto = probabilidad ≥ umbral', lista.every((d) => d.riesgoAlto === d.probabilidad >= r.datos.modelo.umbralRiesgoAlto));
  comprobar('el resumen cuadra con la lista', r.datos.resumen.entregas === lista.length && r.datos.resumen.riesgoAlto === lista.filter((d) => d.riesgoAlto).length);
  comprobar('no incluye entregas cerradas', lista.every((d) => !['entregado', 'devuelto'].includes(d.envio.estado)));
  comprobar('cada riesgo alto explica qué lo sube', lista.filter((d) => d.riesgoAlto).every((d) => d.factores.length > 0));

  const objetivo = lista.find((d) => d.riesgoAlto && !d.confirmacion.sinTelefono && d.confirmacion.estado !== 'CONFIRMADA');
  if (!objetivo) {
    console.log('  (no hay una entrega de riesgo alto con celular para probar la confirmación)');
  } else {
    console.log(`Aviso previo al destinatario · ${objetivo.envio.numeroGuia} (p = ${objetivo.probabilidad})`);
    const id = objetivo.envio.id;
    comprobar('confirmar sin haber pedido la confirmación se rechaza (409)', objetivo.confirmacion.estado === 'PEDIDA' || (await llamar('POST', `/envios/${id}/confirmacion/confirmar`, operador, { uuidOperacion: crypto.randomUUID() })).http === 409);
    comprobar('el remitente no puede pedirla (403)', (await llamar('POST', `/envios/${id}/confirmacion`, cliente, { uuidOperacion: crypto.randomUUID() })).http === 403);
    const uuid = crypto.randomUUID();
    const pedida = await llamar('POST', `/envios/${id}/confirmacion`, operador, { uuidOperacion: uuid });
    comprobar('el operador pide la confirmación: se envía el SMS simulado', pedida.http === 201 && pedida.datos.estado === 'PEDIDA' && /Responde 1/.test(pedida.datos.aviso.mensaje) && /^\*{5}\d{4}$/.test(pedida.datos.aviso.destino), pedida.datos);
    const repetida = await llamar('POST', `/envios/${id}/confirmacion`, operador, { uuidOperacion: uuid });
    comprobar('el mismo UUID no envía dos SMS', repetida.datos.duplicado === true);
    const seguimiento = await llamar('GET', `/envios/${objetivo.envio.numeroGuia}`, operador); // seguimiento por guía
    const avisos = (seguimiento.datos.avisos || []).filter((a) => a.motivo === 'confirmacion');
    comprobar('el aviso queda en el seguimiento del envío', avisos.length >= 1, seguimiento.datos.avisos);
    const confirmada = await llamar('POST', `/envios/${id}/confirmacion/confirmar`, operador, { uuidOperacion: crypto.randomUUID() });
    comprobar('el destinatario responde "1" y queda CONFIRMADA', confirmada.http === 200 && confirmada.datos.estado === 'CONFIRMADA', confirmada.datos);
    const despues = (await llamar('GET', '/ml/riesgo-fallida?fecha=2026-11-21', operador)).datos.datos.find((d) => d.envio.id === id);
    comprobar('con el horario confirmado el riesgo baja', despues.probabilidad < objetivo.probabilidad && despues.confirmacion.estado === 'CONFIRMADA', { antes: objetivo.probabilidad, despues: despues.probabilidad });
  }

  console.log(`\n${pasos - fallos} de ${pasos} comprobaciones correctas.`);
  process.exitCode = fallos ? 1 : 0;
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
