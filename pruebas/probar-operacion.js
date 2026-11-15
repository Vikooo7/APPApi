// Prueba de punta a punta de lo nuevo de la App Admin contra una API local conectada a una COPIA de la base.
// Uso: node --env-file=.env servidor-local.js   (en otra terminal)
//      node pruebas/probar-operacion.js [http://localhost:3000/api]
// Usa las cuentas de ejemplo (clave 1234). No ejecutar contra la base real: cambia datos.

const API = process.argv[2] || 'http://localhost:3000/api';
let pasos = 0;
let fallos = 0;

async function llamar(metodo, ruta, token, cuerpo) {
  const respuesta = await fetch(API + ruta, {
    method: metodo,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: cuerpo ? JSON.stringify(cuerpo) : undefined
  });
  return { http: respuesta.status, datos: await respuesta.json().catch(() => null) };
}

function comprobar(descripcion, condicion, detalle) {
  pasos += 1;
  if (condicion) {
    console.log(`  ✔ ${descripcion}`);
  } else {
    fallos += 1;
    console.log(`  ✖ ${descripcion}`, detalle !== undefined ? JSON.stringify(detalle) : '');
  }
}

async function entrar(correo) {
  const r = await llamar('POST', '/auth/login', null, { correo, clave: '1234' });
  if (r.http !== 200) throw new Error(`No se pudo entrar como ${correo}: ${JSON.stringify(r.datos)}`);
  return r.datos.token;
}

const uuid = () => crypto.randomUUID();
// Imagen JPEG mínima (1×1 px) para la foto de la fachada.
const JPEG =
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=';

(async () => {
  console.log(`API: ${API}`);
  const supervisor = await entrar('supervisor@rutalog.pe');
  const admin = await entrar('operador@rutalog.pe');
  const cliente = await entrar('cliente@rutalog.pe');

  console.log('Couriers');
  const couriers = await llamar('GET', '/couriers', supervisor);
  comprobar('el operador ve 10 couriers', couriers.http === 200 && couriers.datos.datos.length === 10, couriers.datos);
  comprobar('el cliente no puede ver los couriers (403)', (await llamar('GET', '/couriers', cliente)).http === 403);
  const rosa = couriers.datos.datos.find((c) => c.placa === 'BFK-209');
  comprobar('cada courier trae zona, capacidad y paradas activas', rosa && rosa.zona === 'Lima y Callao' && rosa.capacidad === 30, rosa);

  console.log('Envíos');
  const envios = (await llamar('GET', '/envios', supervisor)).datos.datos;
  comprobar('el operador ve todos los envíos (≥ 40)', envios.length >= 40, envios.length);
  const etiquetas = new Set(couriers.datos.datos.map((c) => c.etiqueta));
  const sinEnlace = envios.filter((e) => etiquetas.has(e.transportistaAsignado) && !e.courierId);
  comprobar('los envíos del parcial quedaron enlazados a su courier', sinEnlace.length === 0, sinEnlace.map((e) => e.numeroGuia));
  const zonaSur = (await llamar('GET', '/envios?zona=Sur', supervisor)).datos.datos;
  comprobar('filtro por zona', zonaSur.length > 0 && zonaSur.every((e) => !/Piura|Trujillo|Iquitos/.test(e.ruta)), zonaSur.map((e) => e.ruta));

  console.log('Asignación');
  // El courier con más cupo recibe 2 envíos abiertos de otros couriers (o sin courier): reasignar también es válido.
  const libre = [...couriers.datos.datos].sort((a, b) => b.disponibles - a.disponibles)[0];
  const pendientes = envios
    .filter((e) => ['pendiente', 'recogido', 'en_transito'].includes(e.estado) && e.courierId !== libre.id)
    .slice(0, 2);
  const asignacion = { uuidOperacion: uuid(), courierId: libre.id, envioIds: pendientes.map((e) => e.id) };
  const asignar = await llamar('POST', '/asignaciones', supervisor, asignacion);
  comprobar(
    `asigna ${pendientes.length} envíos a ${libre.nombre}`,
    pendientes.length > 0 && asignar.http === 200 && asignar.datos.asignados === pendientes.length,
    asignar.datos
  );
  const repetida = await llamar('POST', '/asignaciones', supervisor, asignacion);
  comprobar('el mismo UUID no se aplica dos veces', repetida.http === 200 && repetida.datos.duplicado === true, repetida.datos);
  const lleno = await llamar('POST', '/asignaciones', supervisor, {
    uuidOperacion: uuid(),
    courierId: rosa.id,
    envioIds: envios.filter((e) => !['entregado', 'devuelto'].includes(e.estado)).map((e) => e.id).slice(0, 35)
  });
  comprobar('no supera la capacidad de 30 paradas (422)', lleno.http === 422 && lleno.datos.codigo === 'CAPACIDAD_EXCEDIDA', lleno.datos);

  console.log('Compatibilidad con la App Admin del parcial');
  // Se relee del servidor: la asignación de arriba pudo cambiar su versión.
  const elegido = envios.find((e) => e.estado === 'recogido' && e.courierId && !asignacion.envioIds.includes(e.id));
  const enCurso = (await llamar('GET', `/envios/${elegido.id}`, admin)).datos;
  const viejo = await llamar('PUT', `/envios/${enCurso.id}`, admin, {
    uuidOperacion: uuid(),
    estado: 'en_transito',
    transportistaAsignado: 'Carlos Quispe Mamani · AQP-482',
    version: enCurso.version
  });
  comprobar('el texto "Nombre · Placa" se sigue aceptando', viejo.http === 200 && viejo.datos.courierId, viejo.datos);
  const inventado = await llamar('PUT', `/envios/${enCurso.id}`, admin, {
    uuidOperacion: uuid(),
    transportistaAsignado: 'Nadie · XXX-000',
    version: viejo.datos.version
  });
  comprobar('un transportista que no es courier se rechaza (422)', inventado.http === 422 && inventado.datos.codigo === 'COURIER_INVALIDO', inventado.datos);
  // Texto antiguo que no corresponde a ningún courier (ej. "Transportes Andinos SAC"): se puede seguir operando.
  const antiguo = envios.find(
    (e) => e.transportistaAsignado && !e.courierId && ['recogido', 'en_transito'].includes(e.estado)
  );
  if (antiguo) {
    const sigue = await llamar('PUT', `/envios/${antiguo.id}`, admin, {
      uuidOperacion: uuid(),
      estado: antiguo.estado === 'recogido' ? 'en_transito' : 'en_reparto',
      version: antiguo.version
    });
    comprobar(
      `el envío con transportista antiguo "${antiguo.transportistaAsignado}" avanza y lo conserva`,
      sigue.http === 200 && sigue.datos.transportistaAsignado === antiguo.transportistaAsignado,
      sigue.datos
    );
  } else {
    console.log('  · no hay envíos con transportista antiguo en esta base');
  }

  console.log('Entregas fallidas');
  const fallidas = await llamar('GET', '/fallidas', supervisor);
  comprobar('lista de fallidas con sus intentos', fallidas.http === 200 && fallidas.datos.datos.length >= 1, fallidas.datos);
  const fallida = fallidas.datos.datos.find((f) => f.envio.estado === 'fallido');
  if (fallida) {
    const cambio = await llamar('PUT', `/envios/${fallida.envio.id}`, supervisor, {
      uuidOperacion: uuid(),
      estado: 'entregado',
      version: fallida.envio.version
    });
    comprobar('una fallida no pasa a entregado sin reprogramar (409)', cambio.http === 409 && cambio.datos.codigo === 'ENTREGA_FALLIDA', cambio.datos);
    const repro = await llamar('POST', `/envios/${fallida.envio.id}/reprogramar`, supervisor, {
      uuidOperacion: uuid(),
      version: fallida.envio.version
    });
    comprobar('reprogramar deja el envío REPROGRAMADO', repro.http === 200 && repro.datos.estado === 'reprogramado', repro.datos);
  }

  console.log('Entrega fallida registrada por el courier (RN-05)');
  const actuales = (await llamar('GET', '/envios', supervisor)).datos.datos;
  const enReparto = actuales.find((e) => e.estado === 'en_reparto' && e.courierId && e.intentos === 0);
  if (enReparto) {
    const dueno = couriers.datos.datos.find((c) => c.id === enReparto.courierId);
    const otro = couriers.datos.datos.find((c) => c.id !== enReparto.courierId);
    const tokenDueno = await entrar(dueno.correo);
    const ajeno = await llamar('POST', `/envios/${enReparto.id}/fallido`, await entrar(otro.correo), {
      uuidOperacion: uuid(),
      motivo: 'ausente'
    });
    comprobar('otro courier no puede registrar la fallida (403)', ajeno.http === 403, ajeno.datos);
    const sinMotivo = await llamar('POST', `/envios/${enReparto.id}/fallido`, tokenDueno, { uuidOperacion: uuid(), motivo: 'lluvia' });
    comprobar('el motivo debe ser uno de la lista (422)', sinMotivo.http === 422 && sinMotivo.datos.codigo === 'MOTIVO_INVALIDO', sinMotivo.datos);

    const futuro = await llamar('POST', `/envios/${enReparto.id}/fallido`, tokenDueno, {
      uuidOperacion: uuid(),
      motivo: 'ausente',
      foto: JPEG,
      fechaHora: new Date(Date.now() + 86400000).toISOString()
    });
    comprobar('no acepta un evento con hora futura (422)', futuro.http === 422 && futuro.datos.codigo === 'FECHA_INVALIDA', futuro.datos);
    const sinFoto = await llamar('POST', `/envios/${enReparto.id}/fallido`, tokenDueno, { uuidOperacion: uuid(), motivo: 'ausente' });
    comprobar('sin foto de la fachada no se registra (422)', sinFoto.http === 422 && sinFoto.datos.codigo === 'IMAGEN_REQUERIDA', sinFoto.datos);

    let envio = enReparto;
    for (let intento = 1; intento <= 3; intento += 1) {
      const hora = new Date(Date.now() - (4 - intento) * 10 * 60 * 1000).toISOString();
      const r = await llamar('POST', `/envios/${envio.id}/fallido`, tokenDueno, {
        uuidOperacion: uuid(),
        motivo: 'ausente',
        foto: JPEG,
        fechaHora: hora,
        latitud: -12.0464,
        longitud: -77.0428
      });
      const esperado = intento < 3 ? 'fallido' : 'devuelto';
      comprobar(`intento ${intento}: el envío queda ${esperado.toUpperCase()}`, r.http === 201 && r.datos.estado === esperado && r.datos.intentos === intento, r.datos);
      envio = r.datos;
      if (intento < 3) {
        const repro = await llamar('POST', `/envios/${envio.id}/reprogramar`, supervisor, { uuidOperacion: uuid(), version: envio.version });
        comprobar(`intento ${intento}: el operador lo reprograma`, repro.http === 200 && repro.datos.estado === 'reprogramado', repro.datos);
        envio = repro.datos;
      }
    }
    const cerrado = await llamar('POST', `/envios/${envio.id}/reprogramar`, supervisor, { uuidOperacion: uuid(), version: envio.version });
    comprobar('un envío devuelto ya no se reprograma (409)', cerrado.http === 409, cerrado.datos);
    const historial = (await llamar('GET', '/fallidas', supervisor)).datos.datos.find((f) => f.envio.id === enReparto.id);
    comprobar('las fallidas muestran los 3 intentos con su motivo', historial && historial.intentos.length === 3, historial);
  } else {
    console.log('  · no hay envíos en reparto con courier para probar');
  }

  console.log('Courier (lo que usará su app)');
  const courierCorreo = `courier${1}@rutalog.pe`;
  const tokenCourier = await entrar(courierCorreo);
  const propios = (await llamar('GET', '/envios', tokenCourier)).datos.datos;
  comprobar('el courier solo ve sus envíos', propios.every((e) => e.courierId === propios[0]?.courierId), null);
  comprobar('el courier no usa el PUT del operador (403)', (await llamar('PUT', `/envios/${enCurso.id}`, tokenCourier, { uuidOperacion: uuid() })).http === 403);

  console.log(`\n${pasos - fallos} de ${pasos} comprobaciones correctas.`);
  process.exit(fallos ? 1 : 0);
})().catch((e) => {
  console.error('La prueba se detuvo:', e.message);
  process.exit(1);
});
