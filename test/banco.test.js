const test = require('node:test');
const assert = require('node:assert/strict');
const { idDeCodigo, enmascararCuenta, cuotaMensual, cronograma, leerMonto, redondear } = require('../src/banco/nucleo');

const falla = (fn, codigo) => assert.throws(fn, (e) => e.codigo === codigo);

test('el QR se lee con o sin el prefijo BANCOANDINO:, y en minúsculas', () => {
  assert.equal(idDeCodigo('BANCOANDINO:QR-1A2B3C4D5E'), 'QR-1A2B3C4D5E');
  assert.equal(idDeCodigo('qr-1a2b3c4d5e'), 'QR-1A2B3C4D5E');
  falla(() => idDeCodigo('RLP-26-100001-1'), 'QR_INVALIDO');
  falla(() => idDeCodigo('BANCOANDINO:QR-123'), 'QR_INVALIDO');
});

test('montos: positivos, hasta 2 decimales y sin errores de coma flotante', () => {
  assert.equal(leerMonto('189.50'), 189.5);
  assert.equal(leerMonto(0.1 + 0.2), 0.3);
  falla(() => leerMonto(0), 'MONTO_INVALIDO');
  falla(() => leerMonto(-5), 'MONTO_INVALIDO');
  falla(() => leerMonto(10.555), 'MONTO_INVALIDO');
  falla(() => leerMonto('abc'), 'MONTO_INVALIDO');
});

test('la cuenta se muestra enmascarada', () => {
  assert.equal(enmascararCuenta('191-2604001-0'), '***-***4001-0');
});

test('cuota del crédito de la ficha: S/ 70,000 a 48 meses', () => {
  const cuota = cuotaMensual(70000, 48);
  assert.ok(cuota > 1950 && cuota < 2080, `cuota = ${cuota}`);
});

test('el cronograma devuelve exactamente el capital y termina en saldo 0', () => {
  const filas = cronograma(70000, 48, new Date('2026-11-17'));
  assert.equal(filas.length, 48);
  assert.equal(filas.at(-1).saldo, 0);
  assert.equal(redondear(filas.reduce((s, f) => s + f.capital, 0)), 70000);
  assert.ok(filas.every((f) => f.interes >= 0 && f.capital > 0));
  assert.equal(filas[0].fecha, '2026-12-17');
});
