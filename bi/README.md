# Tablero Power BI de RutaLog Perú (fase BI)

Con **datos simulados**: las 12 semanas del histórico de `ml/` (≈5,200 envíos, ≈5,600 intentos, ≈3,200 cobros).

| Archivo | Qué es |
|---|---|
| `construir_bi.py` | Arma el modelo estrella (CSV) y el proyecto de Power BI |
| `datos/*.csv` | Modelo estrella: `fact_envio`, `fact_intento`, `fact_recaudo` y 7 dimensiones |
| `RutaLog/RutaLog.pbip` | El proyecto de Power BI Desktop: se abre con doble clic |

## Modelo estrella

- **Hechos**
  - `fact_envio`: un envío. Peso, costo, contraentrega, intentos, entregado/devuelto, horas de entrega, a tiempo y km del reparto.
  - `fact_intento`: un intento de entrega. Franja, número de intento, si el destinatario confirmó, aviso previo, falló y motivo.
  - `fact_recaudo`: un cobro contraentrega. Recaudado, costo del envío, neto y días hasta la liquidación (martes y viernes).
- **Dimensiones:** `dim_fecha`, `dim_franja`, `dim_ruta`, `dim_zona`, `dim_courier`, `dim_remitente` y `dim_motivo_falla`.
- **Relaciones:** son 13, todas de muchos a uno. La de `fact_recaudo` con la fecha de liquidación está inactiva, porque la activa es la de la fecha del cobro.

## Medidas DAX principales (tabla `Medidas`)

| Medida | DAX | Indicador de la ficha |
|---|---|---|
| % A tiempo | `DIVIDE(SUM(fact_envio[a_tiempo]), [Entregados])` | entregadas en plazo / entregadas |
| % Fallidas | `DIVIDE([Intentos fallidos], [Intentos])` | fallidas / intentos |
| Km por entrega | `DIVIDE(SUM(fact_envio[km_courier]), [Entregados])` | km recorridos / entregas |
| Recaudo | `SUM(fact_recaudo[recaudado])` | Σ cobros confirmados |
| Días hasta liquidar | `AVERAGE(fact_recaudo[dias_hasta_liquidar])` | liquidación − cobro |
| Semana actual | `CALCULATE(MAX(dim_fecha[semana]), fact_intento)` | la última semana con entregas en el filtro |
| … (semana) / (sem. anterior) | `CALCULATE([…], REMOVEFILTERS(dim_fecha), dim_fecha[semana] = s)` y `= s - 1` | comparación semanal (RF-O05) |
| Var. … (pp) | `([… (semana)] − [… (sem. anterior)]) × 100` | variación en puntos porcentuales |

## Páginas del reporte

1. **Resumen semanal**
   - Filtros de zona y semana.
   - 6 tarjetas, cada una con la semana, la semana anterior y la variación.
   - Tasa de fallidas por semana: baja desde que empieza el aviso previo en la S05.
   - Envíos por semana.
   - Tabla semana a semana.
2. **Zonas y couriers**
   - % de fallidas y km por entrega por zona.
   - Entregas por courier.
   - Tabla de desempeño por courier.
3. **Entregas fallidas**
   - Mapa de calor día × franja.
   - Motivos de entrega fallida.
   - Fallidas antes y después del aviso previo, y según si el destinatario confirmó (ML-01).
4. **Remitentes y recaudo**
   - Recaudo, costo, neto y días hasta liquidar por remitente.
   - Recaudo por semana.
   - Días hasta liquidar según el día del cobro.

## Cómo abrirlo

1. Doble clic en `bi\RutaLog\RutaLog.pbip`. Necesita Power BI Desktop de septiembre de 2026 o más reciente.
2. Si aparece un aviso de que el modelo no tiene datos, pulsa **Actualizar** (Inicio → Actualizar).
3. Los CSV se leen desde la carpeta del parámetro `CarpetaDatos` (`V:\MIAPPapi\bi\datos\`). Si mueves la carpeta, cámbialo en **Transformar datos → Parámetros**.
4. Para entregar el tablero: **Archivo → Guardar como → Power BI (.pbix)**.

## Regenerar desde cero

```
node ml\generar-historico.js
ml\.venv\Scripts\python bi\construir_bi.py
```
