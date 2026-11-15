const test = require('node:test');
const assert = require('node:assert/strict');
const {
  CIUDADES,
  distanciaKm,
  coordenadasEnvio,
  longitudRecorrido,
  ordenarParadas
} = require('../src/rutas-optimas');
const { RUTAS, ZONAS } = require('../src/esquema');

const p = (latitud, longitud, id) => ({ latitud, longitud, id });

test('distancia Lima–Arequipa en línea recta (~765 km)', () => {
  const lima = p(...CIUDADES.Lima);
  const arequipa = p(...CIUDADES.Arequipa);
  const km = distanciaKm(lima, arequipa);
  assert.ok(km > 740 && km < 790, `km = ${km}`);
});

test('el orden optimizado nunca es más largo que el orden de registro', () => {
  const inicio = p(0, 0);
  // Registrado en zigzag: ida y vuelta sobre una misma línea.
  const paradas = [p(0, 0.04, 'a'), p(0, 0.01, 'b'), p(0, 0.05, 'c'), p(0, 0.02, 'd'), p(0, 0.03, 'e')];
  const r = ordenarParadas(inicio, paradas);
  assert.deepEqual(r.paradas.map((x) => x.id), ['b', 'd', 'e', 'a', 'c']);
  assert.ok(r.kmOptimizado <= r.kmOrdenRegistro);
  assert.ok(r.ahorroPorcentaje > 0);
});

test('2-opt deshace un cruce que deja el vecino más cercano', () => {
  const inicio = p(0, 0);
  const paradas = [p(1, 0, 'a'), p(1, 1, 'b'), p(0, 1, 'c'), p(0.5, 0.2, 'd')];
  const r = ordenarParadas(inicio, paradas);
  const fuerzaBruta = (resto, actual = []) =>
    resto.length === 0
      ? [actual]
      : resto.flatMap((x, i) => fuerzaBruta([...resto.slice(0, i), ...resto.slice(i + 1)], [...actual, x]));
  const mejor = Math.min(...fuerzaBruta(paradas).map((orden) => longitudRecorrido(inicio, orden)));
  assert.ok(Math.abs(longitudRecorrido(inicio, r.paradas) - mejor) < 1e-6, 'debe llegar al óptimo en este caso');
});

test('sin paradas o con una sola no falla', () => {
  assert.equal(ordenarParadas(p(0, 0), []).paradas.length, 0);
  assert.equal(ordenarParadas(p(0, 0), [p(1, 1, 'x')]).paradas[0].id, 'x');
});

test('cada envío cae siempre en el mismo punto, cerca de su ciudad', () => {
  const a = coordenadasEnvio('uuid-1', 'Lima → Huancayo', 'Junín');
  const b = coordenadasEnvio('uuid-1', 'Lima → Huancayo', 'Junín');
  assert.deepEqual(a, b);
  assert.ok(distanciaKm(a.destino, p(...CIUDADES['Junín'])) < 6);
  assert.ok(distanciaKm(a.origen, p(...CIUDADES.Lima)) < 6);
  const desdeArequipa = coordenadasEnvio('uuid-2', 'Arequipa → Puno', 'Puno');
  assert.ok(distanciaKm(desdeArequipa.origen, p(...CIUDADES.Arequipa)) < 6);
});

test('todas las regiones de las rutas y de las zonas tienen coordenadas', () => {
  for (const [nombre, , , region] of RUTAS) assert.ok(CIUDADES[region], `sin coordenadas: ${nombre}`);
  for (const region of Object.values(ZONAS).flat()) assert.ok(CIUDADES[region], `sin coordenadas: ${region}`);
});
