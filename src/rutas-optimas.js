/**
 * ML-04 · Orden de paradas: vecino más cercano y mejora 2-opt (heurística de la ficha del caso).
 * Las coordenadas de los envíos son simuladas: se ubican alrededor de la capital de la región
 * de destino (entrega) o de la ciudad de origen (recojo), siempre en el mismo punto para cada envío.
 */

// Capital de cada región (latitud, longitud) y ciudades de origen de las rutas.
const CIUDADES = {
  Lima: [-12.0464, -77.0428],
  Callao: [-12.0566, -77.1181],
  Tumbes: [-3.5669, -80.4515],
  Piura: [-5.1945, -80.6328],
  Lambayeque: [-6.7714, -79.8409],
  'La Libertad': [-8.1116, -79.0288],
  Cajamarca: [-7.1638, -78.5003],
  'Áncash': [-9.5278, -77.5278],
  'Huánuco': [-9.9306, -76.2422],
  Pasco: [-10.6826, -76.2562],
  'Junín': [-12.0651, -75.2049],
  Huancavelica: [-12.7861, -74.9760],
  Ayacucho: [-13.1588, -74.2232],
  Ica: [-14.0678, -75.7286],
  'Apurímac': [-13.6339, -72.8814],
  Cusco: [-13.5320, -71.9675],
  Arequipa: [-16.4090, -71.5375],
  Puno: [-15.8402, -70.0219],
  Moquegua: [-17.1932, -70.9349],
  Tacna: [-18.0066, -70.2463],
  Amazonas: [-6.2317, -77.8690],
  'San Martín': [-6.4825, -76.3655],
  Loreto: [-3.7491, -73.2538],
  Ucayali: [-8.3791, -74.5539],
  'Madre de Dios': [-12.5933, -69.1891]
};

// Punto de partida del courier según su zona.
const BASE_DE_ZONA = {
  'Lima y Callao': 'Lima',
  Norte: 'La Libertad',
  Centro: 'Junín',
  Sur: 'Arequipa',
  Oriente: 'Ucayali'
};

// Ciudad de origen de cada ruta ("Lima → Ica" sale de Lima).
const ORIGEN_DE_RUTA = { Arequipa: 'Arequipa', Cusco: 'Cusco' };

const RADIO_TIERRA_KM = 6371;

/** Distancia en km entre dos puntos { latitud, longitud } (fórmula del haversine). */
function distanciaKm(a, b) {
  const rad = (g) => (g * Math.PI) / 180;
  const dLat = rad(b.latitud - a.latitud);
  const dLon = rad(b.longitud - a.longitud);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.latitud)) * Math.cos(rad(b.latitud)) * Math.sin(dLon / 2) ** 2;
  return 2 * RADIO_TIERRA_KM * Math.asin(Math.sqrt(h));
}

/** Número pseudoaleatorio estable a partir de un texto (el mismo envío siempre cae en el mismo punto). */
function semilla(texto) {
  let h = 2166136261;
  for (const c of String(texto)) {
    h ^= c.codePointAt(0);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967295;
}

/** Punto simulado a unos 3 km alrededor del centro de la ciudad. */
function puntoCerca(ciudad, clave) {
  const [lat, lon] = CIUDADES[ciudad] || CIUDADES.Lima;
  const desplazamiento = 0.03;
  return {
    latitud: Number((lat + (semilla(`${clave}:lat`) - 0.5) * 2 * desplazamiento).toFixed(6)),
    longitud: Number((lon + (semilla(`${clave}:lon`) - 0.5) * 2 * desplazamiento).toFixed(6))
  };
}

/** Coordenadas de recojo (origen) y entrega (destino) de un envío, a partir de su ruta y su región. */
function coordenadasEnvio(uuid, nombreRuta, regionDestino) {
  const primeraCiudad = String(nombreRuta || '').split('→')[0].trim();
  const ciudadOrigen = ORIGEN_DE_RUTA[primeraCiudad] || 'Lima';
  return {
    origen: puntoCerca(ciudadOrigen, `${uuid}:origen`),
    destino: puntoCerca(regionDestino, `${uuid}:destino`)
  };
}

function baseDeZona(zona) {
  const [latitud, longitud] = CIUDADES[BASE_DE_ZONA[zona] || 'Lima'];
  return { latitud, longitud };
}

/** Km de recorrer las paradas en ese orden, saliendo de [inicio]. */
function longitudRecorrido(inicio, paradas) {
  let total = 0;
  let actual = inicio;
  for (const parada of paradas) {
    total += distanciaKm(actual, parada);
    actual = parada;
  }
  return total;
}

/** Vecino más cercano: desde donde está, el courier va siempre a la parada más próxima que le falta. */
function vecinoMasCercano(inicio, paradas) {
  const pendientes = [...paradas];
  const orden = [];
  let actual = inicio;
  while (pendientes.length > 0) {
    let mejor = 0;
    for (let i = 1; i < pendientes.length; i += 1) {
      if (distanciaKm(actual, pendientes[i]) < distanciaKm(actual, pendientes[mejor])) mejor = i;
    }
    actual = pendientes.splice(mejor, 1)[0];
    orden.push(actual);
  }
  return orden;
}

/**
 * Mejora 2-opt: invierte tramos del recorrido mientras eso lo acorte (recorrido abierto:
 * empieza en [inicio] y no vuelve). Se detiene cuando ninguna inversión ayuda.
 */
function mejorar2opt(inicio, paradas) {
  let ruta = [...paradas];
  let mejoro = true;
  while (mejoro) {
    mejoro = false;
    for (let i = 0; i < ruta.length - 1; i += 1) {
      for (let k = i + 1; k < ruta.length; k += 1) {
        const candidata = [...ruta.slice(0, i), ...ruta.slice(i, k + 1).reverse(), ...ruta.slice(k + 1)];
        if (longitudRecorrido(inicio, candidata) + 1e-9 < longitudRecorrido(inicio, ruta)) {
          ruta = candidata;
          mejoro = true;
        }
      }
    }
  }
  return ruta;
}

/**
 * Ordena las paradas del día. Devuelve el orden y los km frente al orden de registro (RF-C01),
 * que es la métrica de la ficha: km ahorrados frente al orden en que se registraron.
 */
function ordenarParadas(inicio, paradas) {
  const ordenadas = mejorar2opt(inicio, vecinoMasCercano(inicio, paradas));
  const kmOptimizado = longitudRecorrido(inicio, ordenadas);
  const kmRegistro = longitudRecorrido(inicio, paradas);
  return {
    paradas: ordenadas,
    kmOptimizado: Math.round(kmOptimizado * 10) / 10,
    kmOrdenRegistro: Math.round(kmRegistro * 10) / 10,
    ahorroPorcentaje: kmRegistro > 0 ? Math.round(((kmRegistro - kmOptimizado) / kmRegistro) * 100) : 0
  };
}

module.exports = {
  CIUDADES,
  distanciaKm,
  coordenadasEnvio,
  baseDeZona,
  longitudRecorrido,
  vecinoMasCercano,
  mejorar2opt,
  ordenarParadas
};
