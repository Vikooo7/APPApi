"""Arma el tablero de Power BI de RutaLog Perú (fase BI de la ficha) a partir del histórico simulado.

1. Modelo estrella en CSV (bi/datos/): fact_envio, fact_intento, fact_recaudo y las dimensiones
   dim_fecha, dim_franja, dim_ruta, dim_zona, dim_courier, dim_remitente y dim_motivo_falla.
2. Proyecto de Power BI Desktop (bi/RutaLog/RutaLog.pbip): modelo semántico en TMDL (tablas, relaciones
   y medidas DAX) y reporte en PBIR (4 páginas). Se abre con doble clic en RutaLog.pbip.

Uso, desde V:\\MIAPPapi:  ml\\.venv\\Scripts\\python bi\\construir_bi.py
"""
import json
import shutil
import uuid
from datetime import date, timedelta
from pathlib import Path

import pandas as pd

BI = Path(__file__).resolve().parent
ML = BI.parent / 'ml' / 'datos'
DATOS = BI / 'datos'
PROYECTO = BI / 'RutaLog'
NOMBRE = 'RutaLog'
INICIO = date(2026, 8, 24)  # lunes de la semana 1 del histórico
SEMANA_AVISO = 5            # desde esta semana se pide confirmación a las entregas riesgosas (generar-historico.js)

MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic']
DIAS = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom']
ZONAS = ['Lima y Callao', 'Norte', 'Centro', 'Sur', 'Oriente']
# Los 10 couriers simulados del histórico (mismos nombres que la base, repartidos como en la simulación).
COURIERS = {
    1: ('Rosa Huamán Torres', 'Lima y Callao'), 2: ('Luis Paredes Soto', 'Lima y Callao'),
    3: ('Ana Torres Gil', 'Lima y Callao'), 4: ('Jorge Castillo Vega', 'Norte'), 5: ('Lucía Flores Ramos', 'Norte'),
    6: ('Milagros Rojas Pérez', 'Centro'), 7: ('Carlos Quispe Mamani', 'Sur'), 8: ('Wilber Condori Apaza', 'Sur'),
    9: ('Edwin Tapullima Sangama', 'Oriente'), 10: ('Percy Ccahuana Huillca', 'Oriente'),
}
MOTIVOS = {0: 'Sin falla', 1: 'Ausente', 2: 'Dirección errada', 3: 'Rechazado', 4: 'Zona inaccesible'}
CLAVE_MOTIVO = {'': 0, 'ausente': 1, 'direccion_errada': 2, 'rechazado': 3, 'zona_inaccesible': 4}


def nombres_remitentes(n):
    giros = ['Moda', 'Bodega', 'Importaciones', 'Comercial', 'Boutique', 'Librería', 'Ferretería', 'Market']
    marcas = ['Kiara', 'Sol Andino', 'Inca', 'Pacífico', 'Miraflores', 'Rímac', 'Chavín', 'Misti', 'Amazonía',
              'Huascarán', 'Titicaca', 'Paracas']
    lista = ['Distribuidora Andina SAC', 'Textiles Gamarra EIRL']
    # Recorre las 96 combinaciones en diagonal para que se alternen giros y marcas.
    combinaciones = [f'{giros[i % len(giros)]} {marcas[(i + i // len(marcas)) % len(marcas)]}'
                     for i in range(len(giros) * len(marcas))]
    for nombre in dict.fromkeys(combinaciones):
        if len(lista) == n:
            break
        lista.append(nombre)
    assert len(lista) == n, 'faltan nombres de remitentes'
    return lista


def clave_fecha(serie):
    return pd.to_datetime(serie).dt.strftime('%Y%m%d').astype(int)


# ---------------------------------------------------------------- 1. modelo estrella en CSV
def construir_datos():
    envios = pd.read_csv(ML / 'envios.csv')
    intentos = pd.read_csv(ML / 'intentos.csv').fillna({'motivo': ''})
    recaudo = pd.read_csv(ML / 'recaudo.csv')
    DATOS.mkdir(parents=True, exist_ok=True)

    # Solo semanas completas: los intentos y cobros que caen después del último domingo (los de envíos
    # registrados el fin de semana) formarían una semana 13 de un solo día y distorsionarían la comparación.
    ultima = pd.to_datetime(envios.fecha_registro).max()
    fin = pd.Timestamp(INICIO) + pd.Timedelta(days=7 * (((ultima - pd.Timestamp(INICIO)).days // 7) + 1) - 1)
    intentos = intentos[pd.to_datetime(intentos.fecha) <= fin]
    recaudo = recaudo[pd.to_datetime(recaudo.fecha_cobro) <= fin]
    dias = pd.date_range(INICIO, fin)
    semana = ((dias - pd.Timestamp(INICIO)).days // 7) + 1
    lunes = [INICIO + timedelta(days=7 * (s - 1)) for s in semana]
    dim_fecha = pd.DataFrame({
        'fecha_key': dias.strftime('%Y%m%d').astype(int),
        'fecha': dias.strftime('%Y-%m-%d'),
        'anio': dias.year,
        'mes_num': dias.month,
        'mes': [MESES[m - 1] for m in dias.month],
        'semana': semana,
        'semana_label': [f'S{s:02d} · {l.day} {MESES[l.month - 1]}' for s, l in zip(semana, lunes)],
        'inicio_semana': [l.isoformat() for l in lunes],
        'dia_num': dias.day_of_week + 1,
        'dia': [DIAS[d] for d in dias.day_of_week],
        'fin_de_semana': ['Sí' if d >= 5 else 'No' for d in dias.day_of_week],
        'periodo_aviso': ['Con aviso previo' if s >= SEMANA_AVISO else 'Sin aviso previo' for s in semana],
        'campana': ['Cyber Wow' if date(2026, 10, 19) <= d.date() <= date(2026, 10, 23) else 'Normal' for d in dias],
    })

    dim_zona = pd.DataFrame({'zona_key': range(1, 6), 'zona': ZONAS})
    zona_key = {z: i for i, z in enumerate(ZONAS, start=1)}

    rutas = envios.groupby('ruta', sort=True).agg(region=('region', 'first'), zona=('zona', 'first'),
                                                   distancia_km=('distancia_km', 'first'),
                                                   tiempo_estimado_h=('tiempo_estimado_h', 'first')).reset_index()
    rutas.insert(0, 'ruta_key', range(1, len(rutas) + 1))
    ruta_key = dict(zip(rutas.ruta, rutas.ruta_key))

    dim_courier = pd.DataFrame([{'courier_key': k, 'courier': n, 'zona': z} for k, (n, z) in COURIERS.items()])
    remitentes = nombres_remitentes(int(envios.remitente_id.max()))
    dim_remitente = pd.DataFrame({
        'remitente_key': range(1, len(remitentes) + 1),
        'remitente': remitentes,
        'tipo': ['Tienda online' if i < 30 else 'Empresa' for i in range(len(remitentes))],
    })
    dim_franja = pd.DataFrame({'franja_key': [8, 10, 12, 14, 16, 18]})
    dim_franja['franja'] = [f'{f:02d}–{f + 2:02d} h' for f in dim_franja.franja_key]
    dim_motivo = pd.DataFrame({'motivo_key': list(MOTIVOS), 'motivo': list(MOTIVOS.values())})

    entregado = (envios.resultado == 'entregado').astype(int)
    fact_envio = pd.DataFrame({
        'envio_id': envios.envio_id,
        'fecha_key': clave_fecha(envios.fecha_registro),
        'ruta_key': envios.ruta.map(ruta_key),
        'zona_key': envios.zona.map(zona_key),
        'courier_key': envios.courier_id,
        'remitente_key': envios.remitente_id,
        'peso_kg': envios.peso_kg,
        'costo_envio': envios.costo_envio,
        'contraentrega': envios.contraentrega,
        'monto_contraentrega': envios.monto_contraentrega,
        'intentos': envios.intentos,
        'entregado': entregado,
        'devuelto': 1 - entregado,
        'horas_entrega': envios.horas_entrega,
        'a_tiempo': envios.a_tiempo,
        'km_courier': envios.km_courier.where(entregado == 1),
    })
    fact_intento = pd.DataFrame({
        'intento_id': intentos.intento_id,
        'envio_id': intentos.envio_id,
        'fecha_key': clave_fecha(intentos.fecha),
        'franja_key': intentos.franja,
        'zona_key': intentos.zona.map(zona_key),
        'courier_key': intentos.courier_id,
        'motivo_key': intentos.motivo.map(CLAVE_MOTIVO),
        'numero_intento': intentos.numero_intento,
        'contraentrega': intentos.contraentrega,
        'confirmo_horario': intentos.confirmo_horario,
        'confirmacion': intentos.confirmo_horario.map({1: 'Confirmó el horario', 0: 'No confirmó'}),
        'aviso_previo': intentos.aviso_previo,
        'fallo': intentos.fallo,
    })
    fact_recaudo = pd.DataFrame({
        'envio_id': recaudo.envio_id,
        'remitente_key': recaudo.remitente_id,
        'fecha_cobro_key': clave_fecha(recaudo.fecha_cobro),
        'fecha_liquidacion_key': clave_fecha(recaudo.fecha_liquidacion),
        'recaudado': recaudo.recaudado,
        'costo_envio': recaudo.costo_envio,
        'neto': (recaudo.recaudado - recaudo.costo_envio).round(2),
        'dias_hasta_liquidar': recaudo.dias_hasta_liquidar,
    })

    tablas = {
        'dim_fecha': dim_fecha, 'dim_zona': dim_zona, 'dim_ruta': rutas, 'dim_courier': dim_courier,
        'dim_remitente': dim_remitente, 'dim_franja': dim_franja, 'dim_motivo_falla': dim_motivo,
        'fact_envio': fact_envio, 'fact_intento': fact_intento, 'fact_recaudo': fact_recaudo,
    }
    for nombre, df in tablas.items():
        df.to_csv(DATOS / f'{nombre}.csv', index=False, encoding='utf-8')
    return tablas


# ---------------------------------------------------------------- 2. modelo semántico (TMDL)
def guid(*partes):
    return str(uuid.uuid5(uuid.NAMESPACE_URL, 'rutalog-bi/' + '/'.join(partes)))


def nombre_tmdl(n):
    return n if n.replace('_', '').isalnum() and n.isascii() else "'" + n.replace("'", "''") + "'"


TIPOS = {  # columna → (tipo TMDL, tipo M, formato)
    'int': ('int64', 'Int64.Type', '0'),
    'num': ('double', 'type number', '#,##0.00'),
    'txt': ('string', 'type text', None),
    'fecha': ('dateTime', 'type date', 'dd/mm/yyyy'),
}

# tabla → [(columna, tipo, resumen, ordenarPor, oculta)]
COLUMNAS = {
    'dim_fecha': [('fecha_key', 'int', 'none', None, True), ('fecha', 'fecha', 'none', None, False),
                  ('anio', 'int', 'none', None, False), ('mes_num', 'int', 'none', None, True),
                  ('mes', 'txt', 'none', 'mes_num', False), ('semana', 'int', 'none', None, False),
                  ('semana_label', 'txt', 'none', 'semana', False), ('inicio_semana', 'fecha', 'none', None, False),
                  ('dia_num', 'int', 'none', None, True), ('dia', 'txt', 'none', 'dia_num', False),
                  ('fin_de_semana', 'txt', 'none', None, False), ('periodo_aviso', 'txt', 'none', None, False),
                  ('campana', 'txt', 'none', None, False)],
    'dim_zona': [('zona_key', 'int', 'none', None, True), ('zona', 'txt', 'none', 'zona_key', False)],
    'dim_ruta': [('ruta_key', 'int', 'none', None, True), ('ruta', 'txt', 'none', None, False),
                 ('region', 'txt', 'none', None, False), ('zona', 'txt', 'none', None, False),
                 ('distancia_km', 'num', 'none', None, False), ('tiempo_estimado_h', 'num', 'none', None, False)],
    'dim_courier': [('courier_key', 'int', 'none', None, True), ('courier', 'txt', 'none', None, False),
                    ('zona', 'txt', 'none', None, False)],
    'dim_remitente': [('remitente_key', 'int', 'none', None, True), ('remitente', 'txt', 'none', None, False),
                      ('tipo', 'txt', 'none', None, False)],
    'dim_franja': [('franja_key', 'int', 'none', None, True), ('franja', 'txt', 'none', 'franja_key', False)],
    'dim_motivo_falla': [('motivo_key', 'int', 'none', None, True), ('motivo', 'txt', 'none', 'motivo_key', False)],
    'fact_envio': [('envio_id', 'int', 'none', None, False), ('fecha_key', 'int', 'none', None, True),
                   ('ruta_key', 'int', 'none', None, True), ('zona_key', 'int', 'none', None, True),
                   ('courier_key', 'int', 'none', None, True), ('remitente_key', 'int', 'none', None, True),
                   ('peso_kg', 'num', 'sum', None, False), ('costo_envio', 'num', 'sum', None, False),
                   ('contraentrega', 'int', 'sum', None, False), ('monto_contraentrega', 'num', 'sum', None, False),
                   ('intentos', 'int', 'sum', None, False), ('entregado', 'int', 'sum', None, False),
                   ('devuelto', 'int', 'sum', None, False), ('horas_entrega', 'num', 'average', None, False),
                   ('a_tiempo', 'int', 'sum', None, False), ('km_courier', 'num', 'sum', None, False)],
    'fact_intento': [('intento_id', 'int', 'none', None, False), ('envio_id', 'int', 'none', None, False),
                     ('fecha_key', 'int', 'none', None, True), ('franja_key', 'int', 'none', None, True),
                     ('zona_key', 'int', 'none', None, True), ('courier_key', 'int', 'none', None, True),
                     ('motivo_key', 'int', 'none', None, True), ('numero_intento', 'int', 'none', None, False),
                     ('contraentrega', 'int', 'sum', None, False), ('confirmo_horario', 'int', 'sum', None, False),
                     ('confirmacion', 'txt', 'none', None, False), ('aviso_previo', 'int', 'sum', None, False),
                     ('fallo', 'int', 'sum', None, False)],
    'fact_recaudo': [('envio_id', 'int', 'none', None, False), ('remitente_key', 'int', 'none', None, True),
                     ('fecha_cobro_key', 'int', 'none', None, True), ('fecha_liquidacion_key', 'int', 'none', None, True),
                     ('recaudado', 'num', 'sum', None, False), ('costo_envio', 'num', 'sum', None, False),
                     ('neto', 'num', 'sum', None, False), ('dias_hasta_liquidar', 'num', 'average', None, False)],
}

RELACIONES = [  # (desde, hacia, activa)
    ('fact_envio.fecha_key', 'dim_fecha.fecha_key', True), ('fact_envio.ruta_key', 'dim_ruta.ruta_key', True),
    ('fact_envio.zona_key', 'dim_zona.zona_key', True), ('fact_envio.courier_key', 'dim_courier.courier_key', True),
    ('fact_envio.remitente_key', 'dim_remitente.remitente_key', True),
    ('fact_intento.fecha_key', 'dim_fecha.fecha_key', True), ('fact_intento.franja_key', 'dim_franja.franja_key', True),
    ('fact_intento.zona_key', 'dim_zona.zona_key', True), ('fact_intento.courier_key', 'dim_courier.courier_key', True),
    ('fact_intento.motivo_key', 'dim_motivo_falla.motivo_key', True),
    ('fact_recaudo.fecha_cobro_key', 'dim_fecha.fecha_key', True),
    ('fact_recaudo.fecha_liquidacion_key', 'dim_fecha.fecha_key', False),
    ('fact_recaudo.remitente_key', 'dim_remitente.remitente_key', True),
]

PCT, NUM1, NUM0, SOLES, PP, VARPCT = '0.0%', '#,##0.0', '#,##0', '#,##0.00', '+0.0;-0.0;0.0', '+0.0%;-0.0%;0.0%'

# (nombre, DAX, formato, carpeta). Los de la ficha: entregas a tiempo, fallidas, km por entrega, recaudo, días hasta liquidar.
MEDIDAS = [
    ('Envíos', 'COUNTROWS(fact_envio)', NUM0, 'Entregas'),
    ('Entregados', 'CALCULATE(COUNTROWS(fact_envio), fact_envio[entregado] = 1)', NUM0, 'Entregas'),
    ('Devueltos', 'CALCULATE(COUNTROWS(fact_envio), fact_envio[devuelto] = 1)', NUM0, 'Entregas'),
    ('% A tiempo', 'DIVIDE(SUM(fact_envio[a_tiempo]), [Entregados])', PCT, 'Entregas'),
    ('Horas promedio de entrega', 'AVERAGE(fact_envio[horas_entrega])', NUM1, 'Entregas'),
    ('Km por entrega', 'DIVIDE(SUM(fact_envio[km_courier]), [Entregados])', NUM1, 'Entregas'),
    ('Intentos', 'COUNTROWS(fact_intento)', NUM0, 'Fallidas'),
    ('Intentos fallidos', 'SUM(fact_intento[fallo])', NUM0, 'Fallidas'),
    ('% Fallidas', 'DIVIDE([Intentos fallidos], [Intentos])', PCT, 'Fallidas'),
    ('% Confirmaron horario', 'DIVIDE(SUM(fact_intento[confirmo_horario]), [Intentos])', PCT, 'Fallidas'),
    ('Cobros', 'COUNTROWS(fact_recaudo)', NUM0, 'Recaudo'),
    ('Recaudo', 'SUM(fact_recaudo[recaudado])', SOLES, 'Recaudo'),
    ('Costo de envíos', 'SUM(fact_recaudo[costo_envio])', SOLES, 'Recaudo'),
    ('Neto liquidado', 'SUM(fact_recaudo[neto])', SOLES, 'Recaudo'),
    ('Días hasta liquidar', 'AVERAGE(fact_recaudo[dias_hasta_liquidar])', NUM1, 'Recaudo'),
    # Comparación semanal (RF-O05): la última semana con entregas en el filtro frente a la anterior.
    ('Semana actual', 'CALCULATE(MAX(dim_fecha[semana]), fact_intento)', '0', 'Comparación semanal'),
]
# (medida base, formato, cómo se compara: pp = puntos porcentuales, pct = % de cambio, abs = diferencia)
KPI_SEMANALES = [('% A tiempo', PCT, 'pp'), ('% Fallidas', PCT, 'pp'), ('Km por entrega', NUM1, 'pct'),
                 ('Recaudo', SOLES, 'pct'), ('Días hasta liquidar', NUM1, 'abs'), ('Entregados', NUM0, 'pct')]
for base, formato, tipo in KPI_SEMANALES:
    en_semana = f'VAR s = [Semana actual]\nRETURN CALCULATE([{base}], REMOVEFILTERS(dim_fecha), dim_fecha[semana] = s)'
    anterior = f'VAR s = [Semana actual]\nRETURN CALCULATE([{base}], REMOVEFILTERS(dim_fecha), dim_fecha[semana] = s - 1)'
    actual, previo = f'[{base} (semana)]', f'[{base} (sem. anterior)]'
    if tipo == 'pp':
        nombre_var, dax_var, fmt_var = f'Var. {base} (pp)', f'IF(NOT ISBLANK({previo}), ({actual} - {previo}) * 100)', PP
    elif tipo == 'pct':
        nombre_var, dax_var, fmt_var = f'Var. {base} (%)', f'DIVIDE({actual} - {previo}, {previo})', VARPCT
    else:
        nombre_var, dax_var, fmt_var = f'Var. {base}', f'IF(NOT ISBLANK({previo}), {actual} - {previo})', PP
    MEDIDAS += [(f'{base} (semana)', en_semana, formato, 'Comparación semanal'),
                (f'{base} (sem. anterior)', anterior, formato, 'Comparación semanal'),
                (nombre_var, dax_var, fmt_var, 'Comparación semanal')]
# Variación fila por fila en la tabla de semanas.
for base in ['% A tiempo', '% Fallidas']:
    MEDIDAS.append((
        f'Var. {base} vs sem. ant. (pp)',
        'VAR s = SELECTEDVALUE(dim_fecha[semana])\n'
        f'VAR ant = CALCULATE([{base}], REMOVEFILTERS(dim_fecha), dim_fecha[semana] = s - 1)\n'
        f'RETURN IF(NOT ISBLANK(s) && NOT ISBLANK(ant), ([{base}] - ant) * 100)',
        PP, 'Comparación semanal'))


def m_csv(tabla):
    tipos = ', '.join(f'{{"{c}", {TIPOS[t][1]}}}' for c, t, *_ in COLUMNAS[tabla])
    return [
        'let',
        f'    Origen = Csv.Document(File.Contents(CarpetaDatos & "{tabla}.csv"), [Delimiter = ",", Encoding = 65001, QuoteStyle = QuoteStyle.Csv]),',
        '    Encabezados = Table.PromoteHeaders(Origen, [PromoteAllScalars = true]),',
        '    SinVacios = Table.TransformColumns(Encabezados, {}, each if _ = "" then null else _),',
        f'    Tipos = Table.TransformColumnTypes(SinVacios, {{{tipos}}}, "en-US")',
        'in',
        '    Tipos',
    ]


def tmdl_tabla(tabla):
    L = [f'table {tabla}', f'\tlineageTag: {guid(tabla)}', '']
    for col, tipo, resumen, orden, oculta in COLUMNAS[tabla]:
        dt, _, fmt = TIPOS[tipo]
        L.append(f'\tcolumn {nombre_tmdl(col)}')
        L.append(f'\t\tdataType: {dt}')
        if fmt:
            L.append(f'\t\tformatString: {fmt}')
        if oculta:
            L.append('\t\tisHidden')
        L.append(f'\t\tlineageTag: {guid(tabla, col)}')
        L.append(f'\t\tsummarizeBy: {resumen}')
        L.append(f'\t\tsourceColumn: {col}')
        if orden:
            L.append(f'\t\tsortByColumn: {orden}')
        L += ['', '\t\tannotation SummarizationSetBy = Automatic', '']
    L.append(f'\tpartition {tabla} = m')
    L.append('\t\tmode: import')
    L.append('\t\tsource =')
    L += ['\t\t\t\t' + linea for linea in m_csv(tabla)]
    L += ['', '\tannotation PBI_ResultType = Table', '']
    return '\n'.join(L)


def tmdl_medidas():
    L = ['table Medidas', f'\tlineageTag: {guid("Medidas")}', '']
    for nombre, dax, formato, carpeta in MEDIDAS:
        lineas = dax.split('\n')
        if len(lineas) == 1:
            L.append(f'\tmeasure {nombre_tmdl(nombre)} = {dax}')
        else:
            L.append(f'\tmeasure {nombre_tmdl(nombre)} =')
            L += ['\t\t\t' + linea for linea in lineas]
        L.append(f'\t\tformatString: {formato}')
        L.append(f'\t\tdisplayFolder: {carpeta}')
        L.append(f'\t\tlineageTag: {guid("Medidas", nombre)}')
        L.append('')
    L += ['\tcolumn Columna', '\t\tdataType: string', '\t\tisHidden', f'\t\tlineageTag: {guid("Medidas", "Columna")}',
          '\t\tsummarizeBy: none', '\t\tsourceColumn: Columna', '',
          '\t\tannotation SummarizationSetBy = Automatic', '',
          '\tpartition Medidas = m', '\t\tmode: import', '\t\tsource =',
          '\t\t\t\tlet', '\t\t\t\t    Origen = #table(type table [Columna = text], {})', '\t\t\t\tin', '\t\t\t\t    Origen',
          '', '\tannotation PBI_ResultType = Table', '']
    return '\n'.join(L)


def escribir(ruta, texto):
    ruta.parent.mkdir(parents=True, exist_ok=True)
    ruta.write_text(texto, encoding='utf-8', newline='\n')


def escribir_json(ruta, objeto):
    escribir(ruta, json.dumps(objeto, ensure_ascii=False, indent=2) + '\n')


def construir_modelo():
    sm = PROYECTO / f'{NOMBRE}.SemanticModel'
    d = sm / 'definition'
    escribir_json(sm / 'definition.pbism', {
        '$schema': 'https://developer.microsoft.com/json-schemas/fabric/item/semanticModel/definitionProperties/1.0.0/schema.json',
        'version': '4.2', 'settings': {}})
    escribir(d / 'database.tmdl', 'database\n\tcompatibilityLevel: 1567\n')
    tablas = list(COLUMNAS) + ['Medidas']
    orden = ['CarpetaDatos'] + tablas
    escribir(d / 'model.tmdl', '\n'.join([
        'model Model',
        '\tculture: en-US',
        '\tdefaultPowerBIDataSourceVersion: powerBI_V3',
        '\tsourceQueryCulture: es-PE',
        '\tdataAccessOptions',
        '\t\tlegacyRedirects',
        '\t\treturnErrorValuesAsNull',
        '',
        f'annotation PBI_QueryOrder = {json.dumps(orden, ensure_ascii=False)}',
        '',
        'annotation __PBI_TimeIntelligenceEnabled = 0',
        '',
        *[f'ref table {nombre_tmdl(t)}' for t in tablas],
        '',
    ]))
    carpeta = str(DATOS) + '\\'
    escribir(d / 'expressions.tmdl', '\n'.join([
        f'expression CarpetaDatos = "{carpeta}" meta [IsParameterQuery = true, Type = "Text", IsParameterQueryRequired = true]',
        f'\tlineageTag: {guid("CarpetaDatos")}',
        '',
        '\tannotation PBI_ResultType = Text',
        '',
    ]))
    rel = []
    for desde, hacia, activa in RELACIONES:
        rel += [f'relationship {guid("rel", desde, hacia)}']
        if not activa:
            rel += ['\tisActive: false']
        rel += [f'\tfromColumn: {desde}', f'\ttoColumn: {hacia}', '']
    escribir(d / 'relationships.tmdl', '\n'.join(rel))
    for t in COLUMNAS:
        escribir(d / 'tables' / f'{t}.tmdl', tmdl_tabla(t))
    escribir(d / 'tables' / 'Medidas.tmdl', tmdl_medidas())


# ---------------------------------------------------------------- 3. reporte (PBIR)
ESQ = 'https://developer.microsoft.com/json-schemas/fabric/item/report/definition'


def col(tabla, columna):
    return {'Column': {'Expression': {'SourceRef': {'Entity': tabla}}, 'Property': columna}}


def med(nombre):
    return {'Measure': {'Expression': {'SourceRef': {'Entity': 'Medidas'}}, 'Property': nombre}}


ETIQUETAS = {  # nombre que se ve en el visual (encabezados y leyendas)
    'semana_label': 'Semana', 'zona': 'Zona', 'courier': 'Courier', 'remitente': 'Remitente', 'tipo': 'Tipo',
    'dia': 'Día', 'franja': 'Franja', 'motivo': 'Motivo', 'periodo_aviso': 'Periodo', 'confirmacion': 'Confirmación',
    'Var. % A tiempo vs sem. ant. (pp)': 'Var. a tiempo (pp)', 'Var. % Fallidas vs sem. ant. (pp)': 'Var. fallidas (pp)',
}


def proyeccion(campo, etiqueta=None):
    tipo = 'Column' if 'Column' in campo else 'Measure'
    entidad, prop = campo[tipo]['Expression']['SourceRef']['Entity'], campo[tipo]['Property']
    p = {'field': campo, 'queryRef': f'{entidad}.{prop}', 'nativeQueryRef': prop}
    if etiqueta or prop in ETIQUETAS:
        p['displayName'] = etiqueta or ETIQUETAS[prop]
    return p


def literal(valor):
    return {'expr': {'Literal': {'Value': valor}}}


def visual(nombre, tipo, x, y, w, h, roles, titulo=None, orden_asc=None, z=0):
    v = {'visualType': tipo,
         'query': {'queryState': {rol: {'projections': [proyeccion(*c) if isinstance(c, tuple) else proyeccion(c)
                                                        for c in campos]} for rol, campos in roles.items()}},
         'drillFilterOtherVisuals': True}
    if orden_asc is not None:
        v['query']['sortDefinition'] = {'sort': [{'field': orden_asc, 'direction': 'Ascending'}], 'isDefaultSort': True}
    if titulo:
        texto = "'" + titulo.replace("'", "''") + "'"
        v['visualContainerObjects'] = {'title': [{'properties': {'show': literal('true'), 'text': literal(texto)}}]}
    return {'$schema': f'{ESQ}/visualContainer/1.0.0/schema.json', 'name': nombre,
            'position': {'x': x, 'y': y, 'z': z, 'width': w, 'height': h, 'tabOrder': z}, 'visual': v}


SEMANA = col('dim_fecha', 'semana_label')


def paginas():
    tarjetas = []
    for i, (base, _, tipo) in enumerate(KPI_SEMANALES):
        var = f'Var. {base} (pp)' if tipo == 'pp' else f'Var. {base} (%)' if tipo == 'pct' else f'Var. {base}'
        tarjetas.append(visual(f'kpi{i + 1}', 'multiRowCard', 20 + i * 208, 70, 198, 150,
                               {'Values': [(med(f'{base} (semana)'), 'Esta semana'),
                                           (med(f'{base} (sem. anterior)'), 'Semana anterior'),
                                           (med(var), 'Variación' + (' (pp)' if tipo == 'pp' else ''))]},
                               titulo=base, z=i + 1))
    resumen = [
        visual('filtroZona', 'slicer', 20, 10, 300, 52, {'Values': [col('dim_zona', 'zona')]}, z=0),
        visual('filtroSemana', 'slicer', 340, 10, 300, 52, {'Values': [SEMANA]}, z=20),
        *tarjetas,
        visual('fallidasSemana', 'lineChart', 20, 235, 615, 230, {'Category': [SEMANA], 'Y': [med('% Fallidas')]},
               titulo='Tasa de fallidas por semana (el aviso previo empieza en S05)', orden_asc=SEMANA, z=10),
        visual('enviosSemana', 'clusteredColumnChart', 645, 235, 615, 230,
               {'Category': [SEMANA], 'Y': [med('Envíos')]}, titulo='Envíos registrados por semana', orden_asc=SEMANA, z=11),
        visual('tablaSemanas', 'tableEx', 20, 475, 1240, 235,
               {'Values': [SEMANA, med('Envíos'), med('% A tiempo'), med('Var. % A tiempo vs sem. ant. (pp)'),
                           med('% Fallidas'), med('Var. % Fallidas vs sem. ant. (pp)'), med('Km por entrega'),
                           med('Recaudo'), med('Días hasta liquidar')]},
               titulo='Comparación semana a semana', z=12),
    ]
    zonas = [
        visual('fallidasZona', 'clusteredBarChart', 20, 20, 405, 330,
               {'Category': [col('dim_zona', 'zona')], 'Y': [med('% Fallidas')]}, titulo='% de fallidas por zona', z=1),
        visual('entregasCourier', 'clusteredBarChart', 437, 20, 405, 330,
               {'Category': [col('dim_courier', 'courier')], 'Y': [med('Entregados')]}, titulo='Entregas por courier', z=2),
        visual('kmZona', 'clusteredColumnChart', 855, 20, 405, 330,
               {'Category': [col('dim_zona', 'zona')], 'Y': [med('Km por entrega')]}, titulo='Km por entrega por zona', z=3),
        visual('tablaCouriers', 'tableEx', 20, 365, 1240, 345,
               {'Values': [col('dim_courier', 'courier'), col('dim_courier', 'zona'), med('Entregados'), med('% A tiempo'),
                           med('% Fallidas'), med('Km por entrega'), med('Horas promedio de entrega')]},
               titulo='Desempeño por courier', z=4),
    ]
    fallidas = [
        visual('mapaCalor', 'pivotTable', 20, 20, 615, 330,
               {'Rows': [col('dim_fecha', 'dia')], 'Columns': [col('dim_franja', 'franja')], 'Values': [med('% Fallidas')]},
               titulo='% de fallidas por día y franja horaria', z=1),
        visual('motivos', 'donutChart', 645, 20, 615, 330,
               {'Category': [col('dim_motivo_falla', 'motivo')], 'Y': [med('Intentos fallidos')]},
               titulo='Motivos de entrega fallida', z=2),
        visual('aviso', 'clusteredColumnChart', 20, 365, 405, 345,
               {'Category': [col('dim_fecha', 'periodo_aviso')], 'Y': [med('% Fallidas')]},
               titulo='Fallidas antes y después del aviso previo (ML-01)', z=3),
        visual('confirmacion', 'clusteredColumnChart', 437, 365, 405, 345,
               {'Category': [col('fact_intento', 'confirmacion')], 'Y': [med('% Fallidas')]},
               titulo='Fallidas según si el destinatario confirmó', z=4),
        visual('confirmaronSemana', 'lineChart', 855, 365, 405, 345,
               {'Category': [SEMANA], 'Y': [med('% Confirmaron horario')]},
               titulo='% de entregas con horario confirmado', orden_asc=SEMANA, z=5),
    ]
    recaudo = [
        visual('tablaRemitentes', 'tableEx', 20, 20, 760, 690,
               {'Values': [col('dim_remitente', 'remitente'), col('dim_remitente', 'tipo'), med('Cobros'), med('Recaudo'),
                           med('Costo de envíos'), med('Neto liquidado'), med('Días hasta liquidar')]},
               titulo='Recaudo y liquidación por remitente', z=1),
        visual('recaudoSemana', 'clusteredColumnChart', 795, 20, 465, 335,
               {'Category': [SEMANA], 'Y': [med('Recaudo')]}, titulo='Recaudo contraentrega por semana',
               orden_asc=SEMANA, z=2),
        visual('diasLiquidar', 'clusteredColumnChart', 795, 370, 465, 340,
               {'Category': [col('dim_fecha', 'dia')], 'Y': [med('Días hasta liquidar')]},
               titulo='Días hasta liquidar según el día del cobro (se liquida martes y viernes)',
               orden_asc=col('dim_fecha', 'dia'), z=3),
    ]
    return [('resumen', 'Resumen semanal', resumen), ('zonas', 'Zonas y couriers', zonas),
            ('fallidas', 'Entregas fallidas', fallidas), ('recaudo', 'Remitentes y recaudo', recaudo)]


def construir_reporte():
    rp = PROYECTO / f'{NOMBRE}.Report'
    d = rp / 'definition'
    escribir_json(rp / 'definition.pbir', {
        '$schema': 'https://developer.microsoft.com/json-schemas/fabric/item/report/definitionProperties/2.0.0/schema.json',
        'version': '4.0', 'datasetReference': {'byPath': {'path': f'../{NOMBRE}.SemanticModel'}}})
    escribir_json(d / 'version.json', {'$schema': f'{ESQ}/versionMetadata/1.0.0/schema.json', 'version': '2.0.0'})
    escribir_json(d / 'report.json', {
        '$schema': f'{ESQ}/report/1.0.0/schema.json',
        'themeCollection': {},
        'layoutOptimization': 'None',
        'settings': {'useStylableVisualContainerHeader': True, 'defaultDrillFilterOtherVisuals': True,
                     'allowChangeFilterTypes': True, 'useEnhancedTooltips': True, 'useDefaultAggregateDisplayName': True},
    })
    lista = paginas()
    escribir_json(d / 'pages' / 'pages.json', {'$schema': f'{ESQ}/pagesMetadata/1.0.0/schema.json',
                                               'pageOrder': [p[0] for p in lista], 'activePageName': lista[0][0]})
    for nombre, titulo, visuales in lista:
        escribir_json(d / 'pages' / nombre / 'page.json', {
            '$schema': f'{ESQ}/page/1.0.0/schema.json', 'name': nombre, 'displayName': titulo,
            'displayOption': 'FitToPage', 'height': 720, 'width': 1280})
        for v in visuales:
            escribir_json(d / 'pages' / nombre / 'visuals' / v['name'] / 'visual.json', v)


def construir_pbip():
    escribir_json(PROYECTO / f'{NOMBRE}.pbip', {
        '$schema': 'https://developer.microsoft.com/json-schemas/fabric/pbip/pbipProperties/1.0.0/schema.json',
        'version': '1.0', 'artifacts': [{'report': {'path': f'{NOMBRE}.Report'}}],
        'settings': {'enableAutoRecovery': True}})
    escribir(PROYECTO / '.gitignore', '**/.pbi/localSettings.json\n**/.pbi/cache.abf\n')


if __name__ == '__main__':
    tablas = construir_datos()
    # El proyecto se regenera entero (no toca lo que Power BI guarde en .pbi).
    for sub in [f'{NOMBRE}.SemanticModel/definition', f'{NOMBRE}.Report/definition']:
        shutil.rmtree(PROYECTO / sub, ignore_errors=True)
    construir_modelo()
    construir_reporte()
    construir_pbip()
    print('Modelo estrella:', ', '.join(f'{n} ({len(df):,})' for n, df in tablas.items()))
    print(f'{len(MEDIDAS)} medidas DAX · {len(RELACIONES)} relaciones · {sum(len(p[2]) for p in paginas())} visuales en 4 páginas')
    print('Abrir:', PROYECTO / f'{NOMBRE}.pbip')
