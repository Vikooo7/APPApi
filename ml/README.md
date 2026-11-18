# Machine Learning de RutaLog Perú (fase BI y ML)

Todo con **datos simulados** (como indica la ficha). Se reproduce siempre igual: el generador usa una semilla fija.

| Archivo | Qué es |
|---|---|
| `generar-historico.js` | Genera 12 semanas de histórico simulado (≈5,300 envíos, ≈5,800 intentos) con las 27 rutas y 5 zonas de la API |
| `datos/envios.csv` | Un envío por fila: ruta, zona, peso, contraentrega, courier, horas de entrega, a tiempo, intentos |
| `datos/intentos.csv` | Un intento de entrega por fila: franja, zona, contraentrega, monto, intentos previos, historial del destinatario, confirmación, resultado y motivo |
| `datos/volumen_diario.csv` | Envíos por día y por zona |
| `datos/recaudo.csv` | Cobros contraentrega y su liquidación (martes y viernes) |
| `RutaLog_ML.ipynb` | El notebook ya ejecutado: ML-01, ML-02, ML-03 y la explicación de ML-04 |
| `construir_notebook.py` | Arma y ejecuta el notebook desde cero |
| `modelos/*.json` | Lo que usa la API: coeficientes de ML-01, horas por ruta de ML-02, pronóstico de ML-03 |

## Resultados (semanas 10 a 12 como prueba)

| Modelo | Resultado |
|---|---|
| ML-01 Riesgo de entrega fallida | Regresión logística · AUC ≈ 0.80 · marcando ~14 % de entregas se capta ~57 % de las fallidas (≈4× mejor que al azar) |
| ML-02 Tiempo estimado | Gradient Boosting · MAE ≈ 4.3 h (la estimación simple "ruta + 5 h" tiene 9.4 h) |
| ML-03 Pronóstico de volumen | Regresión con día de la semana, tendencia y campaña · MAPE ≈ 12 % en el total diario |
| ML-04 Orden de paradas | Vecino más cercano + 2-opt (ya en la API y en la App Courier) |

## Dónde se usa cada modelo (el "uso" de la ficha)

| Modelo | Uso | Dónde |
|---|---|---|
| ML-01 | Aviso previo al destinatario y prioridad en la ruta | App Admin: *Riesgo de falla* y marcas en *Asignar envíos* · App Courier: "Riesgo alto · llama antes" en la parada |
| ML-02 | Fecha estimada para el remitente | App Cliente: *Llegada estimada* en el detalle del envío (± 4 h) |
| ML-03 | Cuántos couriers programar | App Admin: pronóstico de mañana por zona en *Asignar envíos* |
| ML-04 | Ruta del día | App Courier: paradas ordenadas y km ahorrados |

La API aplica los modelos con los archivos de `modelos/` (sin Python): `src/ml/riesgo.js` y `src/ml/pronosticos.js`.

## Cómo abrirlo en tu PC

Desde `V:\MIAPPapi`, en una terminal:

```
ml\.venv\Scripts\activate
jupyter notebook ml\RutaLog_ML.ipynb
```

Si la carpeta `ml\.venv` no existe (por ejemplo, en otra PC), primero:

```
python -m venv ml\.venv
ml\.venv\Scripts\python -m pip install numpy pandas scikit-learn matplotlib jupyter nbclient ipykernel
```

Para regenerar todo desde cero: `node ml\generar-historico.js` y luego `ml\.venv\Scripts\python ml\construir_notebook.py`.
