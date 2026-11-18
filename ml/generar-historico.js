// Histórico SIMULADO de RutaLog Perú (la ficha: "Todos los datos del proyecto son simulados").
// 12 semanas de envíos con sus intentos de entrega, tiempos y recaudo, para entrenar ML-01, ML-02 y ML-03
// y para el modelo estrella de Power BI. Es reproducible: con la misma semilla salen los mismos datos.
//
// Uso: node ml/generar-historico.js            → ml/datos/*.csv
//
// Cómo se "fabrica" cada resultado (lo que los modelos deberán descubrir):
//  - Riesgo de falla: más alto temprano (8 h) y al final del día (18 h), en zonas alejadas, en contraentrega
//    y montos altos, con intentos previos, si el destinatario ya falló antes y si el courier va sobrecargado.
//    Confirmar el horario lo baja mucho. Desde la semana 5 RutaLog avisa antes a las entregas riesgosas
//    (como propone la ficha): las fallidas bajan de ~11 % a ~6 %.
//  - Horas de entrega: tiempo de la ruta + almacén + peso + carga del courier + fin de semana + reintentos.
//  - Volumen diario: tendencia, día de la semana y campaña Cyber Wow (19 al 23 de octubre).
const fs = require('fs');
const path = require('path');
const { RUTAS, ZONAS } = require('../src/esquema');
const { CIUDADES, distanciaKm } = require('../src/rutas-optimas');

const SEMILLA = 20261118;
const SEMANAS = 12;
const FIN = new Date('2026-11-15T00:00:00Z'); // domingo: el histórico termina la semana pasada
const INICIO = new Date(FIN.getTime() - (SEMANAS * 7 - 1) * 86400000);
const SEMANA_AVISO = 5; // desde esta semana se pide confirmación a las entregas riesgosas
const FRANJAS = [8, 10, 12, 14, 16, 18];
const EFECTO_FRANJA = { 8: 1.05, 10: 0.3, 12: 0, 14: -0.15, 16: 0.25, 18: 0.95 };
const EFECTO_ZONA = { 'Lima y Callao': 0, Norte: 0.35, Centro: 0.65, Sur: 0.4, Oriente: 1.25 };
const PESO_ZONA = { 'Lima y Callao': 0.42, Norte: 0.17, Centro: 0.13, Sur: 0.17, Oriente: 0.11 };
const N_REMITENTES = 48; // la ficha habla de 48 remitentes en la liquidación
const N_COURIERS = 10;
const N_DESTINATARIOS = 2600;

// ---------- azar reproducible ----------
function mulberry32(a) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const azar = mulberry32(SEMILLA);
const uniforme = (a, b) => a + (b - a) * azar();
const entero = (a, b) => Math.floor(uniforme(a, b + 1));
const elegir = (lista) => lista[Math.floor(azar() * lista.length)];
const bernoulli = (p) => azar() < p;
function normal(media = 0, desv = 1) {
  const u = Math.max(azar(), 1e-12);
  return media + desv * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * azar());
}
function poisson(lambda) {
  let L = Math.exp(-lambda), k = 0, p = 1;
  do { k += 1; p *= azar(); } while (p > L);
  return k - 1;
}
function elegirPonderado(pesos) {
  const total = Object.values(pesos).reduce((s, v) => s + v, 0);
  let r = azar() * total;
  for (const [clave, peso] of Object.entries(pesos)) {
    r -= peso;
    if (r <= 0) return clave;
  }
  return Object.keys(pesos)[0];
}
const sigmoide = (x) => 1 / (1 + Math.exp(-x));
const redondear = (n, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
const fecha = (d) => d.toISOString().slice(0, 10);

// ---------- catálogos ----------
const zonaDe = (region) => Object.entries(ZONAS).find(([, regiones]) => regiones.includes(region))?.[0];
const rutasPorZona = {};
for (const [nombre, horas, tarifa, region] of RUTAS) {
  const zona = zonaDe(region);
  const origen = nombre.split(' → ')[0];
  const km = Math.round(distanciaKm(
    { latitud: CIUDADES[origen][0], longitud: CIUDADES[origen][1] },
    { latitud: CIUDADES[region][0], longitud: CIUDADES[region][1] }
  ) * 1.25 + (region === 'Lima' ? 45 : 0)); // por carretera ≈ 1.25 × línea recta
  (rutasPorZona[zona] ||= []).push({ nombre, horas, tarifa, region, zona, km });
}
// Cada courier atiende una zona, como en la base real (Lima tiene más).
const COURIERS = Array.from({ length: N_COURIERS }, (_, i) => ({
  id: i + 1,
  zona: ['Lima y Callao', 'Lima y Callao', 'Lima y Callao', 'Norte', 'Norte', 'Centro', 'Sur', 'Sur', 'Oriente', 'Oriente'][i]
}));
const REMITENTES = Array.from({ length: N_REMITENTES }, (_, i) => ({
  id: i + 1,
  contraentrega: i < 30 ? 0.75 : 0.25, // las tiendas online cobran casi todo al recibir
  tamano: i < 8 ? 3 : i < 24 ? 1.5 : 0.7
}));
const historialDestinatario = new Map(); // destinatario → fallas anteriores (lo que "sabe" RutaLog)

// ---------- volumen por día (para ML-03) ----------
const FACTOR_DIA = [0.45, 1.15, 1.05, 1.0, 1.05, 1.2, 0.8]; // dom..sáb
function enviosDelDia(d, semana) {
  const cyber = d >= new Date('2026-10-19T00:00:00Z') && d <= new Date('2026-10-23T00:00:00Z') ? 1.6 : 1;
  const tendencia = 1 + 0.018 * semana;
  return Math.max(0, poisson(56 * FACTOR_DIA[d.getUTCDay()] * tendencia * cyber));
}

// ---------- generación ----------
const envios = [];
const intentos = [];
const volumen = [];
let idEnvio = 0;
let idIntento = 0;

for (let d = new Date(INICIO); d <= FIN; d = new Date(d.getTime() + 86400000)) {
  const semana = Math.floor((d - INICIO) / (7 * 86400000)) + 1;
  const n = enviosDelDia(d, semana);
  const porZona = Object.fromEntries(Object.keys(ZONAS).map((z) => [z, 0]));
  const cargaDia = new Map(COURIERS.map((c) => [c.id, 0]));
  const delDia = [];

  for (let i = 0; i < n; i++) {
    const zona = elegirPonderado(PESO_ZONA);
    porZona[zona] += 1;
    const ruta = elegir(rutasPorZona[zona]);
    const remitente = REMITENTES[Math.floor(Math.pow(azar(), 1.6) * N_REMITENTES)];
    const contraentrega = bernoulli(remitente.contraentrega);
    const peso = redondear(Math.max(0.3, Math.exp(normal(1.2, 0.9))), 1);
    const courier = elegir(COURIERS.filter((c) => c.zona === zona));
    cargaDia.set(courier.id, cargaDia.get(courier.id) + 1);
    delDia.push({
      envio_id: ++idEnvio,
      fecha_registro: fecha(d),
      dia_semana: d.getUTCDay(),
      semana,
      zona,
      region: ruta.region,
      ruta: ruta.nombre,
      distancia_km: ruta.km,
      tiempo_estimado_h: ruta.horas,
      peso_kg: peso,
      costo_envio: redondear(peso * ruta.tarifa),
      contraentrega: contraentrega ? 1 : 0,
      monto_contraentrega: contraentrega ? redondear(Math.min(2500, Math.exp(normal(4.9, 0.7))), 0) : 0,
      remitente_id: remitente.id,
      destinatario_id: entero(1, N_DESTINATARIOS),
      courier_id: courier.id
    });
  }
  volumen.push({ fecha: fecha(d), dia_semana: d.getUTCDay(), semana, total: n, ...porZona });

  for (const e of delDia) {
    e.carga_courier = cargaDia.get(e.courier_id) + entero(0, 6); // paradas del día (incluye otros clientes)
    // ---- intentos de entrega (ML-01) ----
    let entregado = false;
    let horasExtra = 0;
    let numero = 0;
    let fallasPrevias = historialDestinatario.get(e.destinatario_id) || 0;
    while (!entregado && numero < 3) {
      numero += 1;
      const franja = elegir(FRANJAS);
      const avisoActivo = e.semana >= SEMANA_AVISO;
      // Riesgo "previo" sin confirmación: con el aviso, RutaLog pide confirmar a las entregas riesgosas.
      const base =
        -4.08 + EFECTO_FRANJA[franja] + EFECTO_ZONA[e.zona] + (e.contraentrega ? 0.6 : 0) + e.monto_contraentrega / 1000 * 0.9 +
        (numero - 1) * 0.6 + Math.min(fallasPrevias, 3) * 1.15 + (e.carga_courier > 26 ? 0.45 : 0) + (e.dia_semana === 6 ? 0.2 : 0);
      const aviso = avisoActivo && sigmoide(base) > 0.08;
      const confirmo = aviso ? bernoulli(0.6) : bernoulli(0.12);
      const pFalla = sigmoide(base + (confirmo ? -2.1 : 0));
      const fallo = bernoulli(pFalla);
      let motivo = '';
      if (fallo) {
        motivo = elegirPonderado({
          ausente: 52,
          direccion_errada: 23,
          rechazado: e.contraentrega ? 17 : 9,
          zona_inaccesible: e.zona === 'Oriente' || e.zona === 'Centro' ? 16 : 8
        });
        fallasPrevias += 1;
      }
      intentos.push({
        intento_id: ++idIntento,
        envio_id: e.envio_id,
        fecha: fecha(new Date(new Date(e.fecha_registro).getTime() + (Math.ceil(e.tiempo_estimado_h / 24) + numero - 1) * 86400000)),
        semana: e.semana,
        dia_semana: (e.dia_semana + Math.ceil(e.tiempo_estimado_h / 24) + numero - 1) % 7,
        franja,
        zona: e.zona,
        contraentrega: e.contraentrega,
        monto_contraentrega: e.monto_contraentrega,
        numero_intento: numero,
        fallas_previas_destinatario: Math.min(fallasPrevias - (fallo ? 1 : 0), 5),
        confirmo_horario: confirmo ? 1 : 0,
        aviso_previo: aviso ? 1 : 0,
        carga_courier: e.carga_courier,
        courier_id: e.courier_id,
        fallo: fallo ? 1 : 0,
        motivo
      });
      if (fallo) horasExtra += 24 + uniforme(0, 12);
      else entregado = true;
    }
    historialDestinatario.set(e.destinatario_id, fallasPrevias);

    // ---- horas de entrega (ML-02) ----
    const findeSemana = e.dia_semana === 6 || e.dia_semana === 0 ? 10 : 0;
    const horas =
      e.tiempo_estimado_h * uniforme(0.85, 1.2) + 5 + e.peso_kg * 0.05 + e.carga_courier * 0.25 + findeSemana +
      horasExtra + Math.max(0, normal(0, 3) + (azar() < 0.07 ? uniforme(6, 30) : 0)); // algunos retrasos grandes
    e.intentos = numero;
    e.resultado = entregado ? 'entregado' : 'devuelto';
    e.horas_entrega = entregado ? redondear(horas, 1) : '';
    // Promesa al remitente: el tiempo de la ruta + 1 día.
    e.a_tiempo = entregado ? (horas <= e.tiempo_estimado_h + 24 ? 1 : 0) : 0;
    e.km_courier = redondear(e.zona === 'Lima y Callao' ? uniforme(3, 12) : uniforme(5, 25), 1); // km del reparto final
    envios.push(e);
  }
}

// ---------- recaudo (fact_recaudo de Power BI) ----------
// Lo cobrado se liquida el martes o viernes siguiente (RF-R05).
const recaudo = [];
for (const e of envios) {
  if (!e.contraentrega || e.resultado !== 'entregado') continue;
  const cobrado = new Date(new Date(e.fecha_registro).getTime() + Math.ceil(Number(e.horas_entrega) / 24) * 86400000);
  let liq = new Date(cobrado.getTime() + 86400000);
  while (![2, 5].includes(liq.getUTCDay())) liq = new Date(liq.getTime() + 86400000);
  recaudo.push({
    envio_id: e.envio_id,
    remitente_id: e.remitente_id,
    fecha_cobro: fecha(cobrado),
    fecha_liquidacion: fecha(liq),
    recaudado: e.monto_contraentrega,
    costo_envio: e.costo_envio,
    dias_hasta_liquidar: Math.round((liq - cobrado) / 86400000)
  });
}

// ---------- CSV ----------
function guardar(nombre, filas) {
  const columnas = Object.keys(filas[0]);
  const texto = [columnas.join(','), ...filas.map((f) => columnas.map((c) => JSON.stringify(f[c] ?? '')).join(','))].join('\n');
  fs.writeFileSync(path.join(__dirname, 'datos', nombre), texto + '\n');
  console.log(`${nombre}: ${filas.length} filas`);
}
fs.mkdirSync(path.join(__dirname, 'datos'), { recursive: true });
guardar('envios.csv', envios);
guardar('intentos.csv', intentos);
guardar('volumen_diario.csv', volumen);
guardar('recaudo.csv', recaudo);

// Resumen para revisar que el histórico se parece a la ficha.
const tasa = (filas) => (100 * filas.filter((f) => f.fallo).length / filas.length).toFixed(1);
const antes = intentos.filter((i) => i.semana < SEMANA_AVISO);
const despues = intentos.filter((i) => i.semana >= SEMANA_AVISO + 2);
const motivos = {};
intentos.filter((i) => i.fallo).forEach((i) => (motivos[i.motivo] = (motivos[i.motivo] || 0) + 1));
const totalFallas = Object.values(motivos).reduce((s, v) => s + v, 0);
console.log(`Fallidas: ${tasa(antes)} % antes del aviso → ${tasa(despues)} % con aviso`);
console.log('Motivos:', Object.entries(motivos).map(([m, n]) => `${m} ${(100 * n / totalFallas).toFixed(0)} %`).join(' · '));
console.log(`A tiempo: ${(100 * envios.filter((e) => e.a_tiempo).length / envios.length).toFixed(1)} % · contraentrega: ${(100 * envios.filter((e) => e.contraentrega).length / envios.length).toFixed(0)} %`);
