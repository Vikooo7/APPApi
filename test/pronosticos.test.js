const test = require('node:test');
const assert = require('node:assert/strict');
const { estimarEntrega, pronosticarVolumen, variablesVolumen } = require('../src/ml/pronosticos');
const TIEMPO = require('../ml/modelos/tiempo-entrega.json');

test('ML-02: fecha estimada = registro + horas del modelo para la ruta', () => {
  // Miércoles 18/11 a las 10:00 de Lima (15:00 UTC).
  const e = estimarEntrega({ creado_en: '2026-11-18T15:00:00Z', ruta: 'Lima → Callao', intentos: 0 });
  const horas = TIEMPO.horas_por_ruta['Lima → Callao'].entre_semana;
  assert.equal(e.horas, horas);
  assert.equal(new Date(e.fechaEstimada).getTime(), Date.parse('2026-11-18T15:00:00Z') + horas * 3600e3);
  assert.equal(e.margenHoras, Math.round(TIEMPO.mae_horas_prueba));
  assert.equal(e.porRuta, true);
});

test('ML-02: fin de semana tarda más y cada reintento suma un día', () => {
  const sabado = estimarEntrega({ creado_en: '2026-11-21T15:00:00Z', ruta: 'Lima → Callao', intentos: 0 });
  assert.equal(sabado.horas, TIEMPO.horas_por_ruta['Lima → Callao'].fin_de_semana);
  const reintento = estimarEntrega({ creado_en: '2026-11-18T15:00:00Z', ruta: 'Lima → Callao', intentos: 1 });
  assert.equal(reintento.horas, TIEMPO.horas_por_ruta['Lima → Callao'].entre_semana + 24);
});

test('ML-02: ruta fuera del modelo usa "ruta + 5 h"; sin datos no inventa', () => {
  assert.equal(estimarEntrega({ creado_en: '2026-11-18T15:00:00Z', ruta: 'Ruta nueva', intentos: 0 }, 10).horas, 15);
  assert.equal(estimarEntrega({ creado_en: '2026-11-18T15:00:00Z', ruta: 'Ruta nueva', intentos: 0 }), null);
});

test('ML-03: variables del día y couriers = envíos / 30 redondeado hacia arriba', () => {
  const jueves = new Date('2026-11-19T00:00:00Z');
  const x = variablesVolumen(jueves);
  assert.equal(x.dia_4, 1);
  assert.equal(x.dia_1 + x.dia_2 + x.dia_3 + x.dia_5 + x.dia_6, 0);
  assert.equal(x.cyber, 0);
  const p = pronosticarVolumen(jueves);
  assert.equal(p.zonas.length, 5);
  assert.equal(p.total, p.zonas.reduce((s, z) => s + z.envios, 0));
  for (const z of p.zonas) assert.equal(z.couriersSugeridos, z.envios > 0 ? Math.ceil(z.envios / 30) : 0);
  // El domingo se esperan menos envíos que el lunes (patrón semanal del histórico).
  assert.ok(pronosticarVolumen(new Date('2026-11-22T00:00:00Z')).total < pronosticarVolumen(new Date('2026-11-23T00:00:00Z')).total);
});
