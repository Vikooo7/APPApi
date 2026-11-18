const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluar, variables, franjaPorOrden, MODELO } = require('../src/ml/riesgo');
const { leerFecha } = require('../src/ml/rutas');

const base = {
  montoContraentrega: 0,
  intentos: 0,
  fallasDestinatario: 0,
  confirmado: false,
  cargaCourier: 10,
  franja: 12,
  zona: 'Lima y Callao',
  fecha: new Date('2026-11-19T00:00:00Z') // jueves
};

test('el modelo exportado por el notebook es coherente', () => {
  const n = MODELO.variables.length;
  assert.equal(MODELO.media.length, n);
  assert.equal(MODELO.desviacion.length, n);
  assert.equal(MODELO.coeficientes.length, n);
  assert.ok(MODELO.umbral_riesgo_alto > 0 && MODELO.umbral_riesgo_alto < 1);
  assert.deepEqual(Object.keys(variables(base)).sort(), [...MODELO.variables].sort());
});

test('la fórmula es la de la regresión logística (sigmoide del intercepto en la media)', () => {
  // Con cada variable igual a su media, todos los aportes son 0 y queda solo el intercepto.
  let z = MODELO.intercepto;
  MODELO.variables.forEach((v, i) => {
    z += (MODELO.coeficientes[i] * (variables(base)[v] - MODELO.media[i])) / MODELO.desviacion[i];
  });
  assert.equal(evaluar(base).probabilidad, Math.round((1 / (1 + Math.exp(-z))) * 1000) / 1000);
});

test('confirmar el horario baja el riesgo; Oriente, 8 h y fallas previas lo suben', () => {
  const dificil = { ...base, zona: 'Oriente', franja: 8, fallasDestinatario: 2, montoContraentrega: 350, intentos: 1 };
  const sinConfirmar = evaluar(dificil);
  const confirmado = evaluar({ ...dificil, confirmado: true });
  assert.ok(sinConfirmar.riesgoAlto, 'una entrega así debe marcarse como riesgo alto');
  assert.ok(confirmado.probabilidad < sinConfirmar.probabilidad);
  assert.ok(evaluar(base).probabilidad < sinConfirmar.probabilidad);
  assert.equal(evaluar(base).riesgoAlto, false, 'una entrega prepagada en Lima a mediodía es de riesgo normal');
  assert.ok(sinConfirmar.factores.length > 0 && sinConfirmar.factores.length <= 3);
  assert.ok(sinConfirmar.factores.includes('El destinatario ya falló otras entregas'));
});

test('tres niveles como en la ficha: el medio es la mitad del alto', () => {
  const { nivelDe, UMBRAL_ALTO, UMBRAL_MEDIO } = require('../src/ml/riesgo');
  assert.equal(UMBRAL_ALTO, MODELO.umbral_riesgo_alto);
  assert.ok(Math.abs(UMBRAL_MEDIO - UMBRAL_ALTO / 2) < 0.001);
  assert.equal(nivelDe(UMBRAL_ALTO), 'alto');
  assert.equal(nivelDe(UMBRAL_ALTO - 0.001), 'medio');
  assert.equal(nivelDe(UMBRAL_MEDIO), 'medio');
  assert.equal(nivelDe(UMBRAL_MEDIO - 0.001), 'bajo');
  const r = evaluar({ ...base, zona: 'Oriente', franja: 8, fallasDestinatario: 2 });
  assert.equal(r.riesgoAlto, r.nivel === 'alto');
});

test('la franja sale del orden de la parada: 5 paradas por franja de 2 h', () => {
  assert.equal(franjaPorOrden(1), 8);
  assert.equal(franjaPorOrden(5), 8);
  assert.equal(franjaPorOrden(6), 10);
  assert.equal(franjaPorOrden(26), 18);
  assert.equal(franjaPorOrden(30), 18);
  assert.equal(franjaPorOrden(null), null);
});

test('la fecha por defecto es mañana y se valida el formato', () => {
  assert.equal(leerFecha('2026-11-21').getUTCDay(), 6);
  assert.throws(() => leerFecha('21/11/2026'), { codigo: 'FECHA_INVALIDA' });
  const manana = leerFecha(undefined);
  assert.ok(manana.getTime() > Date.now() - 24 * 3600 * 1000);
});
