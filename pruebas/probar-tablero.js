// Prueba del tablero (RF-O05, HU-O03) contra una API local conectada a una COPIA de la base.
// Uso: node pruebas/probar-tablero.js [http://localhost:3000/api]

const API = process.argv[2] || 'http://localhost:3000/api';
let pasos = 0;
let fallos = 0;

async function llamar(ruta, token) {
  const r = await fetch(API + ruta, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  return { http: r.status, datos: await r.json().catch(() => null) };
}
async function entrar(correo) {
  const r = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ correo, clave: '1234' })
  });
  return (await r.json()).token;
}
function comprobar(descripcion, condicion, detalle) {
  pasos += 1;
  if (condicion) console.log(`  ✔ ${descripcion}`);
  else {
    fallos += 1;
    console.log(`  ✖ ${descripcion}`, detalle !== undefined ? JSON.stringify(detalle) : '');
  }
}

(async () => {
  console.log(`API: ${API}`);
  const operador = await entrar('supervisor@rutalog.pe');
  const admin = await entrar('operador@rutalog.pe');
  const cliente = await entrar('cliente@rutalog.pe');
  const courier = await entrar('courier1@rutalog.pe');

  console.log('Permisos (tabla de roles de la ficha)');
  comprobar('sin sesión: 401', (await llamar('/tablero')).http === 401);
  comprobar('el remitente no ve el tablero (403)', (await llamar('/tablero', cliente)).http === 403);
  comprobar('el courier tampoco (403)', (await llamar('/tablero', courier)).http === 403);
  comprobar('una semana mal escrita: 422', (await llamar('/tablero?semana=18-11-2026', operador)).http === 422);

  console.log('Indicadores con comparación semanal');
  const r = await llamar('/tablero?semana=2026-11-18', operador);
  const t = r.datos;
  comprobar('el operador ve el tablero de la semana lunes a domingo', r.http === 200 && t.semana.inicio === '2026-11-16' && t.semana.fin === '2026-11-22' && t.semanaAnterior.inicio === '2026-11-09', t?.semana);
  comprobar('el administrador también', (await llamar('/tablero?semana=2026-11-18', admin)).http === 200);
  comprobar('son los 6 indicadores de la ficha', t.indicadores.map((i) => i.clave).join() === 'a_tiempo,fallidas,km_por_entrega,recaudo,dias_hasta_liquidar,con_evidencia');
  comprobar('cada uno trae valor, semana anterior, variación y fórmula', t.indicadores.every((i) => 'valor' in i && 'anterior' in i && 'variacion' in i && i.formula));
  comprobar('variación = valor − anterior', t.indicadores.every((i) => i.variacion === null || Math.abs(i.variacion - (i.valor - i.anterior)) < 0.051));
  comprobar('los porcentajes están entre 0 y 100', t.indicadores.filter((i) => i.unidad === '%').every((i) => i.valor === null || (i.valor >= 0 && i.valor <= 100)));
  const fallidas = t.indicadores.find((i) => i.clave === 'fallidas').valor;
  const esperado = t.entregadas + t.intentosFallidos > 0 ? Math.round((1000 * t.intentosFallidos) / (t.entregadas + t.intentosFallidos)) / 10 : null;
  comprobar('fallidas = fallidas / intentos', fallidas === esperado, { fallidas, esperado });
  comprobar('las entregas por courier suman las de la semana', t.porCourier.reduce((s, c) => s + c.entregas, 0) <= t.entregadas);
  comprobar('la tendencia trae 8 semanas', t.tendencia.length === 8 && t.tendencia[7].semana === '2026-11-16');
  comprobar('el recaudo pendiente de liquidar viene aparte', typeof t.recaudoPendiente.monto === 'number');

  console.log(`\n${pasos - fallos} de ${pasos} comprobaciones correctas.`);
  process.exitCode = fallos ? 1 : 0;
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
