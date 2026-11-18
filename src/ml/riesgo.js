// ML-01 · Riesgo de entrega fallida (RF-O02). El modelo se entrena en ml/RutaLog_ML.ipynb (regresión logística)
// y se exporta a ml/modelos/modelo-riesgo.json: media y desviación de cada variable, coeficientes, intercepto
// y umbral de "riesgo alto". Aquí solo se aplica la fórmula, sin Python:
//   z = intercepto + Σ coeficiente × (valor − media) / desviación      probabilidad = 1 / (1 + e^(−z))
const MODELO = require('../../ml/modelos/modelo-riesgo.json');

const TEXTOS = {
  contraentrega: 'Es contraentrega',
  monto_miles: 'Monto alto a cobrar',
  intentos_previos: 'Ya tuvo intentos fallidos',
  fallas_previas_destinatario: 'El destinatario ya falló otras entregas',
  confirmo_horario: 'El destinatario confirmó el horario',
  courier_sobrecargado: 'Courier con más de 26 paradas',
  sabado: 'Entrega en sábado',
  franja_8h: 'Franja de 8 h',
  franja_10h: 'Franja de 10 h',
  franja_16h: 'Franja de 16 h',
  franja_18h: 'Franja de 18 h',
  zona_Norte: 'Zona Norte',
  zona_Centro: 'Zona Centro',
  zona_Sur: 'Zona Sur',
  zona_Oriente: 'Zona Oriente'
};

const PARADAS_POR_FRANJA = 5; // 30 paradas como máximo (RF-O01) repartidas de 8 a 18 h en franjas de 2 h

/** Franja horaria estimada (8, 10, ... 18) por el orden de la parada en la ruta del día; null si aún no tiene ruta. */
function franjaPorOrden(orden) {
  if (!Number.isInteger(orden) || orden < 1) return null;
  return 8 + 2 * Math.min(5, Math.floor((orden - 1) / PARADAS_POR_FRANJA));
}

/**
 * Variables del modelo para una entrega. [e] trae: montoContraentrega, intentos, fallasDestinatario,
 * confirmado, cargaCourier, franja (o null), zona y fecha (día en que se entregará).
 */
function variables(e) {
  const x = {
    contraentrega: e.montoContraentrega > 0 ? 1 : 0,
    monto_miles: (Number(e.montoContraentrega) || 0) / 1000,
    intentos_previos: Number(e.intentos) || 0,
    fallas_previas_destinatario: Math.min(Number(e.fallasDestinatario) || 0, 3),
    confirmo_horario: e.confirmado ? 1 : 0,
    courier_sobrecargado: (Number(e.cargaCourier) || 0) > 26 ? 1 : 0,
    sabado: e.fecha && e.fecha.getUTCDay() === 6 ? 1 : 0
  };
  for (const f of [8, 10, 16, 18]) x[`franja_${f}h`] = e.franja === f ? 1 : 0; // 12 y 14 h (o sin ruta) = referencia
  for (const z of ['Norte', 'Centro', 'Sur', 'Oriente']) x[`zona_${z}`] = e.zona === z ? 1 : 0; // Lima y Callao = referencia
  return x;
}

// Niveles como en la ficha (alto 0.50 · medio 0.25 = la mitad · bajo). El umbral alto es el que eligió el notebook
// (F2 con a lo más 30 % marcadas): con ~7 % de fallidas, 0.50 casi nunca se alcanza. El medio es la mitad del alto.
const UMBRAL_ALTO = MODELO.umbral_riesgo_alto;
const UMBRAL_MEDIO = Math.round((MODELO.umbral_riesgo_alto / 2) * 1000) / 1000;

/** alto → pedir confirmación del horario · medio → aviso por notificación el mismo día · bajo → sin acción. */
function nivelDe(probabilidad) {
  if (probabilidad >= UMBRAL_ALTO) return 'alto';
  if (probabilidad >= UMBRAL_MEDIO) return 'medio';
  return 'bajo';
}

/** Probabilidad de falla, su nivel y los 3 factores que más la suben (para explicarla en la App Admin). */
function evaluar(entrega) {
  const x = variables(entrega);
  let z = MODELO.intercepto;
  const aportes = [];
  MODELO.variables.forEach((nombre, i) => {
    const aporte = (MODELO.coeficientes[i] * (x[nombre] - MODELO.media[i])) / MODELO.desviacion[i];
    z += aporte;
    if (x[nombre] && MODELO.coeficientes[i] > 0) aportes.push({ variable: nombre, texto: TEXTOS[nombre], aporte });
  });
  const probabilidad = 1 / (1 + Math.exp(-z));
  return {
    probabilidad: Math.round(probabilidad * 1000) / 1000,
    nivel: nivelDe(probabilidad),
    riesgoAlto: probabilidad >= UMBRAL_ALTO,
    factores: aportes.sort((a, b) => b.aporte - a.aporte).slice(0, 3).map((a) => a.texto)
  };
}

const infoModelo = () => ({
  nombre: MODELO.modelo,
  entrenadoCon: MODELO.entrenado_con,
  umbralRiesgoAlto: UMBRAL_ALTO,
  umbralRiesgoMedio: UMBRAL_MEDIO,
  metricasPrueba: MODELO.metricas_prueba
});

module.exports = { evaluar, nivelDe, variables, franjaPorOrden, infoModelo, MODELO, UMBRAL_ALTO, UMBRAL_MEDIO };
