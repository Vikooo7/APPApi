const test = require('node:test');
const assert = require('node:assert/strict');
const { inicioDeSemana, DEFINICIONES } = require('../src/tablero');

test('la semana empieza el lunes', () => {
  assert.equal(inicioDeSemana('2026-11-18').toISOString().slice(0, 10), '2026-11-16'); // miércoles → lunes
  assert.equal(inicioDeSemana('2026-11-16').toISOString().slice(0, 10), '2026-11-16'); // lunes
  assert.equal(inicioDeSemana('2026-11-22').toISOString().slice(0, 10), '2026-11-16'); // domingo → lunes anterior
  assert.equal(inicioDeSemana(undefined).getUTCDay(), 1);
});

test('una semana mal escrita se rechaza', () => {
  assert.throws(() => inicioDeSemana('18/11/2026'), { codigo: 'FECHA_INVALIDA' });
});

test('el tablero tiene los 6 indicadores de la ficha', () => {
  assert.deepEqual(
    DEFINICIONES.map((d) => d[1]),
    ['Entregas a tiempo', 'Entregas fallidas', 'Km por entrega', 'Recaudo contraentrega', 'Días hasta liquidar', 'Entregas con evidencia']
  );
});
