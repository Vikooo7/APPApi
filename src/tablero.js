// RF-O05 / HU-O03: tablero de la operación con comparación semanal. Los indicadores y sus fórmulas son los de la
// ficha: entregas a tiempo, entregas fallidas, km por entrega, recaudo, días hasta liquidar y entregas con evidencia.
// Las semanas van de lunes a domingo en hora de Lima.
const express = require('express');
const { consulta } = require('./db');
const { error, requiereSesion } = require('./auth');
const { esOperacion } = require('./envios');
const { longitudRecorrido } = require('./rutas-optimas');

const rutasTablero = express.Router();
const ZONA_HORARIA = 'America/Lima';
const DIA_MS = 24 * 3600 * 1000;
const redondear = (n, d = 1) => (n === null || n === undefined || Number.isNaN(n) ? null : Math.round(n * 10 ** d) / 10 ** d);
const iso = (d) => d.toISOString().slice(0, 10);

/** Lunes de la semana que contiene [fecha] (AAAA-MM-DD) o de la semana actual en Lima. */
function inicioDeSemana(fecha) {
  let dia;
  if (fecha === undefined || fecha === '') {
    const ahoraLima = new Date(Date.now() - 5 * 3600 * 1000);
    dia = new Date(Date.UTC(ahoraLima.getUTCFullYear(), ahoraLima.getUTCMonth(), ahoraLima.getUTCDate()));
  } else {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(fecha)) || Number.isNaN(new Date(`${fecha}T00:00:00Z`).getTime())) {
      throw error(422, 'FECHA_INVALIDA', 'La semana se indica con una fecha AAAA-MM-DD.');
    }
    dia = new Date(`${fecha}T00:00:00Z`);
  }
  const desdeLunes = (dia.getUTCDay() + 6) % 7; // lunes = 0
  return new Date(dia.getTime() - desdeLunes * DIA_MS);
}

/** Tasa en % o null si no hay base. */
const porcentaje = (parte, total) => (total > 0 ? (100 * parte) / total : null);

/** Km de reparto por entrega: por courier y día, recorriendo sus entregas en el orden de la ruta (ML-04). */
async function kmPorEntrega(desde, hasta) {
  const { rows } = await consulta(
    `SELECT p.courier_id, p.fecha, p.orden, p.envio_id, p.latitud, p.longitud
     FROM paradas p
     WHERE p.tipo = 'entrega' AND p.fecha >= $1::date AND p.fecha < $2::date AND p.latitud IS NOT NULL
     ORDER BY p.courier_id, p.fecha, p.orden`,
    [iso(desde), iso(hasta)]
  );
  const porDia = new Map();
  for (const p of rows) {
    const clave = `${p.courier_id}:${iso(new Date(p.fecha))}`;
    if (!porDia.has(clave)) porDia.set(clave, { paradas: [] });
    porDia.get(clave).paradas.push({ envioId: p.envio_id, latitud: Number(p.latitud), longitud: Number(p.longitud) });
  }
  let km = 0;
  let kmOrdenRegistro = 0;
  let entregas = 0;
  // Se mide entre paradas, desde la primera entrega: el traslado desde la base no es parte del reparto.
  const recorrido = (lista) => longitudRecorrido(lista[0], lista.slice(1));
  for (const { paradas } of porDia.values()) {
    km += recorrido(paradas);
    kmOrdenRegistro += recorrido([...paradas].sort((a, b) => a.envioId - b.envioId));
    entregas += paradas.length;
  }
  return {
    kmPorEntrega: entregas > 0 ? km / entregas : null,
    // ML-04: cuánto menos se recorre con la ruta ordenada que en el orden de registro.
    ahorroRutaPct: kmOrdenRegistro > 0 ? (100 * (kmOrdenRegistro - km)) / kmOrdenRegistro : null
  };
}

/** Los 6 indicadores de una semana [desde, hasta). */
async function indicadores(desde, hasta) {
  const rango = [desde.toISOString().slice(0, 10), hasta.toISOString().slice(0, 10), ZONA_HORARIA];
  const desdeTs = '($1::date)::timestamp AT TIME ZONE $3';
  const hastaTs = '($2::date)::timestamp AT TIME ZONE $3';

  const [entregas, fallidas, recaudo, liquidacion, km] = await Promise.all([
    consulta(
      `WITH ent AS (
         SELECT DISTINCT ON (ev.envio_id) ev.envio_id, ev.fecha_hora_evento
         FROM eventos_envio ev
         WHERE ev.estado = 'entregado' AND ev.fecha_hora_evento >= ${desdeTs} AND ev.fecha_hora_evento < ${hastaTs}
         ORDER BY ev.envio_id, ev.fecha_hora_evento)
       SELECT COUNT(*)::int AS entregadas,
              -- Promesa al remitente (la misma del histórico simulado): tiempo de la ruta + 1 día.
              COUNT(*) FILTER (WHERE ent.fecha_hora_evento <= e.creado_en + make_interval(hours => r.tiempo_estimado + 24))::int AS a_tiempo,
              COUNT(ev.id)::int AS con_evidencia
       FROM ent JOIN envios e ON e.id = ent.envio_id
       LEFT JOIN rutas r ON r.nombre = e.ruta
       LEFT JOIN evidencias ev ON ev.envio_id = e.id`,
      rango
    ),
    consulta(`SELECT COUNT(*)::int AS fallidas FROM intentos_fallidos WHERE fecha >= ${desdeTs} AND fecha < ${hastaTs}`, rango),
    consulta(
      `SELECT COALESCE(SUM(monto), 0) AS recaudado FROM cobros
       WHERE tipo = 'contraentrega' AND estado IN ('CONFIRMADO', 'LIQUIDADO')
         AND confirmado_en >= ${desdeTs} AND confirmado_en < ${hastaTs}`,
      rango
    ),
    consulta(
      `SELECT AVG(EXTRACT(EPOCH FROM (l.transferida_en - c.confirmado_en)) / 86400) AS dias
       FROM cobros c JOIN liquidaciones l ON l.id = c.liquidacion_id
       WHERE l.estado = 'TRANSFERIDA' AND l.transferida_en >= ${desdeTs} AND l.transferida_en < ${hastaTs}`,
      rango
    ),
    kmPorEntrega(desde, hasta)
  ]);

  const { entregadas, a_tiempo: aTiempo, con_evidencia: conEvidencia } = entregas.rows[0];
  const nFallidas = fallidas.rows[0].fallidas;
  return {
    entregadas,
    fallidas: nFallidas,
    valores: {
      a_tiempo: porcentaje(aTiempo, entregadas),
      fallidas: porcentaje(nFallidas, nFallidas + entregadas),
      km_por_entrega: km.kmPorEntrega,
      recaudo: Number(recaudo.rows[0].recaudado),
      dias_hasta_liquidar: liquidacion.rows[0].dias === null ? null : Number(liquidacion.rows[0].dias),
      con_evidencia: porcentaje(conEvidencia, entregadas)
    },
    ahorroRutaPct: km.ahorroRutaPct
  };
}

// Nombre, unidad, si es mejor que suba o que baje, decimales y fórmula (tal como en la ficha).
const DEFINICIONES = [
  ['a_tiempo', 'Entregas a tiempo', '%', 'sube', 1, 'entregadas en plazo / entregadas'],
  ['fallidas', 'Entregas fallidas', '%', 'baja', 1, 'fallidas / intentos'],
  ['km_por_entrega', 'Km por entrega', 'km', 'baja', 1, 'km recorridos / entregas'],
  ['recaudo', 'Recaudo contraentrega', 'S/', 'sube', 2, 'Σ cobros confirmados'],
  ['dias_hasta_liquidar', 'Días hasta liquidar', 'días', 'baja', 1, 'liquidación − cobro'],
  ['con_evidencia', 'Entregas con evidencia', '%', 'sube', 1, 'con foto y firma / entregadas']
];

/**
 * GET /api/tablero?semana=AAAA-MM-DD (operador o administrador) → los 6 indicadores de la semana con su
 * valor de la semana anterior y la variación (en puntos si es %), el recaudo pendiente de liquidar,
 * las entregas por courier y la tendencia de las últimas 8 semanas.
 */
rutasTablero.get('/tablero', requiereSesion, async (req, res, next) => {
  try {
    if (!esOperacion(req)) throw error(403, 'SIN_PERMISO', 'El tablero es de la operación.');
    const inicio = inicioDeSemana(req.query.semana);
    const fin = new Date(inicio.getTime() + 7 * DIA_MS);
    const inicioAnterior = new Date(inicio.getTime() - 7 * DIA_MS);
    const inicioHistorico = new Date(inicio.getTime() - 7 * 7 * DIA_MS);

    const [actual, anterior, pendiente, porCourier, historico] = await Promise.all([
      indicadores(inicio, fin),
      indicadores(inicioAnterior, inicio),
      consulta(
        `SELECT COALESCE(SUM(monto), 0) AS monto, COUNT(*)::int AS cobros FROM cobros
         WHERE tipo = 'contraentrega' AND estado = 'CONFIRMADO' AND liquidacion_id IS NULL`
      ),
      consulta(
        `SELECT u.nombre AS courier,
                COUNT(*) FILTER (WHERE x.tipo = 'entrega')::int AS entregas,
                COUNT(*) FILTER (WHERE x.tipo = 'fallida')::int AS fallidas
         FROM (
           SELECT ev.usuario_id AS courier_id, 'entrega' AS tipo FROM eventos_envio ev
           WHERE ev.estado = 'entregado' AND ev.fecha_hora_evento >= ($1::date)::timestamp AT TIME ZONE $3
             AND ev.fecha_hora_evento < ($2::date)::timestamp AT TIME ZONE $3
           UNION ALL
           SELECT i.courier_id, 'fallida' FROM intentos_fallidos i
           WHERE i.fecha >= ($1::date)::timestamp AT TIME ZONE $3 AND i.fecha < ($2::date)::timestamp AT TIME ZONE $3
         ) x JOIN usuarios u ON u.id = x.courier_id AND u.rol = 'courier'
         GROUP BY u.nombre ORDER BY entregas DESC, u.nombre`,
        [iso(inicio), iso(fin), ZONA_HORARIA]
      ),
      consulta(
        `SELECT semana::date AS semana, SUM(entregas)::int AS entregas, SUM(fallidas)::int AS fallidas FROM (
           SELECT date_trunc('week', fecha_hora_evento AT TIME ZONE $3) AS semana, 1 AS entregas, 0 AS fallidas
           FROM eventos_envio WHERE estado = 'entregado' AND fecha_hora_evento >= ($1::date)::timestamp AT TIME ZONE $3
             AND fecha_hora_evento < ($2::date)::timestamp AT TIME ZONE $3
           UNION ALL
           SELECT date_trunc('week', fecha AT TIME ZONE $3), 0, 1
           FROM intentos_fallidos WHERE fecha >= ($1::date)::timestamp AT TIME ZONE $3 AND fecha < ($2::date)::timestamp AT TIME ZONE $3
         ) x GROUP BY semana ORDER BY semana`,
        [iso(inicioHistorico), iso(fin), ZONA_HORARIA]
      )
    ]);

    const porSemana = new Map(historico.rows.map((h) => [iso(new Date(h.semana)), h]));
    const tendencia = [];
    for (let s = inicioHistorico.getTime(); s < fin.getTime(); s += 7 * DIA_MS) {
      const h = porSemana.get(iso(new Date(s))) || { entregas: 0, fallidas: 0 };
      tendencia.push({
        semana: iso(new Date(s)),
        entregas: h.entregas,
        fallidas: h.fallidas,
        fallidasPct: redondear(porcentaje(h.fallidas, h.entregas + h.fallidas))
      });
    }

    res.json({
      semana: { inicio: iso(inicio), fin: iso(new Date(fin.getTime() - DIA_MS)) },
      semanaAnterior: { inicio: iso(inicioAnterior), fin: iso(new Date(inicio.getTime() - DIA_MS)) },
      entregadas: actual.entregadas,
      intentosFallidos: actual.fallidas,
      indicadores: DEFINICIONES.map(([clave, nombre, unidad, mejorSi, decimales, formula]) => {
        const valor = redondear(actual.valores[clave], decimales);
        const previo = redondear(anterior.valores[clave], decimales);
        return {
          clave,
          nombre,
          unidad,
          mejorSi,
          formula,
          valor,
          anterior: previo,
          // En los % la variación está en puntos porcentuales (pp), como en la ficha.
          variacion: valor === null || previo === null ? null : redondear(valor - previo, decimales)
        };
      }),
      ahorroRutaPct: redondear(actual.ahorroRutaPct),
      recaudoPendiente: { monto: redondear(Number(pendiente.rows[0].monto), 2), cobros: pendiente.rows[0].cobros },
      porCourier: porCourier.rows,
      tendencia
    });
  } catch (e) {
    next(e);
  }
});

module.exports = { rutasTablero, inicioDeSemana, DEFINICIONES };
