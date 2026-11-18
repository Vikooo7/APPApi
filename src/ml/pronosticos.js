// ML-02 y ML-03 en la API, con los modelos que exporta el notebook (ml/RutaLog_ML.ipynb):
//  - ML-02 Tiempo estimado de entrega (Gradient Boosting): horas por ruta, entre semana y en fin de semana.
//    Uso en la ficha: "Fecha estimada para el remitente".
//  - ML-03 Pronóstico de volumen (regresión con día de la semana, tendencia y campaña) por zona.
//    Uso en la ficha: "Cuántos couriers programar".
const TIEMPO = require('../../ml/modelos/tiempo-entrega.json');
const VOLUMEN = require('../../ml/modelos/pronostico-volumen.json');

const HORA_MS = 3600 * 1000;
const DIA_MS = 24 * HORA_MS;
const LIMA_MS = -5 * HORA_MS;
const HORAS_POR_REINTENTO = 24; // una entrega fallida se reprograma para el día siguiente

/** Día de la semana en Lima (0 = domingo). */
const diaEnLima = (fecha) => new Date(fecha.getTime() + LIMA_MS).getUTCDay();

/**
 * Fecha estimada de entrega de un envío (ML-02). Parte de la hora de registro, suma las horas que el modelo
 * estima para su ruta (según si se registró entre semana o en fin de semana) y un día por cada reintento.
 * [tiempoRutaH] es el respaldo si la ruta no está en el modelo: la estimación simple "ruta + 5 h".
 */
function estimarEntrega(envio, tiempoRutaH = null) {
  const registro = new Date(envio.creado_en);
  if (Number.isNaN(registro.getTime())) return null;
  const finDeSemana = [0, 6].includes(diaEnLima(registro));
  const porRuta = TIEMPO.horas_por_ruta[envio.ruta];
  let horas = porRuta ? porRuta[finDeSemana ? 'fin_de_semana' : 'entre_semana'] : tiempoRutaH !== null ? Number(tiempoRutaH) + 5 : null;
  if (horas === null) return null;
  horas += (Number(envio.intentos) || 0) * HORAS_POR_REINTENTO;
  return {
    fechaEstimada: new Date(registro.getTime() + horas * HORA_MS).toISOString(),
    horas: Math.round(horas * 10) / 10,
    margenHoras: Math.round(TIEMPO.mae_horas_prueba),
    modelo: TIEMPO.modelo,
    porRuta: Boolean(porRuta)
  };
}

/** Variables de ML-03 para un día: tendencia, día de la semana (lunes..sábado) y campaña Cyber Wow. */
function variablesVolumen(fecha) {
  const inicio = new Date(`${VOLUMEN.inicio_tendencia}T00:00:00Z`);
  const dia = fecha.getUTCDay(); // la fecha ya es el día en Lima a medianoche UTC
  const x = { tendencia: Math.round((fecha.getTime() - inicio.getTime()) / DIA_MS) };
  for (let d = 1; d <= 6; d += 1) x[`dia_${d}`] = dia === d ? 1 : 0;
  const iso = fecha.toISOString().slice(0, 10);
  x.cyber = iso >= '2026-10-19' && iso <= '2026-10-23' ? 1 : 0;
  return x;
}

/** Envíos esperados por zona para [fecha] y cuántos couriers programar (hasta 30 paradas cada uno, RF-O01). */
function pronosticarVolumen(fecha) {
  const x = variablesVolumen(fecha);
  const porCourier = VOLUMEN.paradas_por_courier || 30;
  const zonas = Object.entries(VOLUMEN.coeficientes)
    .filter(([zona]) => zona !== 'total')
    .map(([zona, c]) => {
      const valor = Object.entries(c).reduce((s, [nombre, coef]) => s + (nombre === 'intercepto' ? coef : coef * (x[nombre] || 0)), 0);
      const envios = Math.max(0, Math.round(valor));
      return { zona, envios, couriersSugeridos: envios > 0 ? Math.ceil(envios / porCourier) : 0 };
    });
  return {
    fecha: fecha.toISOString().slice(0, 10),
    modelo: VOLUMEN.modelo,
    paradasPorCourier: porCourier,
    total: zonas.reduce((s, z) => s + z.envios, 0),
    zonas
  };
}

module.exports = { estimarEntrega, pronosticarVolumen, variablesVolumen };
