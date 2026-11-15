// Prueba de punta a punta de la App Courier contra una API local conectada a una COPIA de la base.
// Uso: node --env-file=.env servidor-local.js   (en otra terminal)
//      node pruebas/probar-courier.js [http://localhost:3000/api]
// Usa las cuentas de ejemplo (clave 1234). No ejecutar contra la base real: crea y entrega envíos.

const API = process.argv[2] || 'http://localhost:3000/api';
const BASE = API.replace(/\/api$/, '');
let pasos = 0;
let fallos = 0;

// Imágenes mínimas válidas: JPEG 1×1 (foto) y PNG 1×1 (firma).
const JPEG =
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=';
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

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
const guiaNueva = () => `RLP-26-${String(Math.floor(800000 + Math.random() * 99999))}-0`;

(async () => {
  console.log(`API: ${API}`);
  const cliente = await entrar('cliente@rutalog.pe');
  const cliente2 = await entrar('cliente2@rutalog.pe');
  const supervisor = await entrar('supervisor@rutalog.pe');

  // Dos envíos nuevos: uno prepagado y uno contraentrega.
  const base = {
    ruta: 'Lima → Huancayo',
    pesoKg: 1.2,
    destinatarioNombre: 'Carlos Mendoza',
    destinatarioTelefono: '987654321',
    destinatarioDireccion: 'Av. Huancavelica 512, El Tambo'
  };
  const prepagado = (await llamar('POST', '/envios', cliente, { ...base, uuidOperacion: uuid(), uuid: uuid(), numeroGuia: guiaNueva() })).datos;
  const contraentrega = (
    await llamar('POST', '/envios', cliente, { ...base, uuidOperacion: uuid(), uuid: uuid(), numeroGuia: guiaNueva(), montoContraentrega: 50 })
  ).datos;
  comprobar('los envíos nuevos traen coordenadas de recojo y entrega', prepagado.origenLatitud !== null && prepagado.destinoLatitud !== null, prepagado);

  const couriers = (await llamar('GET', '/couriers', supervisor)).datos.datos;
  const courier = [...couriers].sort((a, b) => b.disponibles - a.disponibles)[0];
  const otroCourier = couriers.find((c) => c.id !== courier.id);
  await llamar('POST', '/asignaciones', supervisor, { uuidOperacion: uuid(), courierId: courier.id, envioIds: [prepagado.id, contraentrega.id] });
  const token = await entrar(courier.correo);
  const tokenOtro = await entrar(otroCourier.correo);

  console.log(`Ruta del día de ${courier.nombre} (RF-C01, ML-04)`);
  const ruta = await llamar('GET', '/courier/ruta', token);
  const paradas = ruta.datos?.paradas || [];
  comprobar('devuelve las paradas numeradas en orden', ruta.http === 200 && paradas.every((p, i) => p.orden === i + 1), ruta.datos);
  comprobar(
    'los dos envíos nuevos son paradas de recojo',
    [prepagado.id, contraentrega.id].every((id) => paradas.some((p) => p.envio.id === id && p.tipo === 'recojo')),
    paradas.map((p) => [p.envio.id, p.tipo])
  );
  comprobar(
    `el orden de ML-04 no es más largo que el de registro (${ruta.datos.kmOptimizado} km vs ${ruta.datos.kmOrdenRegistro} km)`,
    ruta.datos.kmOptimizado <= ruta.datos.kmOrdenRegistro
  );
  comprobar('un cliente no puede pedir la ruta del courier (403)', (await llamar('GET', '/courier/ruta', cliente)).http === 403);

  console.log('Reordenar a mano (RF-C02)');
  const invertido = [...paradas].reverse().map((p) => ({ envioId: p.envio.id, tipo: p.tipo }));
  const reorden = await llamar('PUT', '/courier/ruta/orden', token, { uuidOperacion: uuid(), paradas: invertido });
  comprobar(
    'guarda el orden del courier y lo marca como manual',
    reorden.http === 200 && reorden.datos.ordenManual && reorden.datos.paradas[0].envio.id === invertido[0].envioId,
    reorden.datos
  );
  const deNuevo = await llamar('GET', '/courier/ruta', token);
  comprobar('al volver a pedir la ruta se respeta el orden manual', deNuevo.datos.ordenManual === true);
  const incompleta = await llamar('PUT', '/courier/ruta/orden', token, { uuidOperacion: uuid(), paradas: invertido.slice(1) });
  comprobar('si faltan paradas en el orden nuevo, se rechaza (409)', incompleta.http === 409 && incompleta.datos.codigo === 'RUTA_CAMBIO', incompleta.datos);

  console.log('Recojo con escaneo de guía (RF-C03)');
  const gps = { latitud: -12.05, longitud: -77.04 };
  const malaGuia = await llamar('POST', `/envios/${prepagado.id}/eventos`, token, { uuidOperacion: uuid(), estado: 'recogido', guia: 'RLP-26-000000-0', ...gps });
  comprobar('si la guía escaneada no es la de la parada, avisa (422)', malaGuia.http === 422 && malaGuia.datos.codigo === 'GUIA_NO_COINCIDE', malaGuia.datos);
  const ajeno = await llamar('POST', `/envios/${prepagado.id}/eventos`, tokenOtro, { uuidOperacion: uuid(), estado: 'recogido', guia: prepagado.numeroGuia });
  comprobar('otro courier no puede registrar el recojo (403)', ajeno.http === 403, ajeno.datos);
  const recogido = await llamar('POST', `/envios/${prepagado.id}/eventos`, token, {
    uuidOperacion: uuid(),
    estado: 'recogido',
    guia: prepagado.numeroGuia.toLowerCase(),
    ...gps
  });
  comprobar('con la guía correcta queda RECOGIDO', recogido.http === 200 && recogido.datos.estado === 'recogido', recogido.datos);
  const repetido = await llamar('POST', `/envios/${prepagado.id}/eventos`, token, { uuidOperacion: uuid(), estado: 'recogido', guia: prepagado.numeroGuia });
  comprobar('el mismo avance reenviado sin señal no cambia nada', repetido.http === 200 && repetido.datos.version === recogido.datos.version, repetido.datos);
  const salto = await llamar('POST', `/envios/${prepagado.id}/eventos`, token, { uuidOperacion: uuid(), estado: 'en_reparto' });
  comprobar('no salta de recogido a en reparto (409)', salto.http === 409 && salto.datos.codigo === 'TRANSICION_INVALIDA', salto.datos);
  const antes = await llamar('POST', `/envios/${prepagado.id}/evidencia`, token, { uuidOperacion: uuid(), foto: JPEG, firma: PNG, recibeNombre: 'X', recibeDni: '12345678' });
  comprobar('no se entrega algo que no está en reparto (409)', antes.http === 409, antes.datos);

  const anterior = await llamar('POST', `/envios/${prepagado.id}/eventos`, token, {
    uuidOperacion: uuid(),
    estado: 'en_transito',
    fechaHora: new Date(Date.now() - 2 * 86400000).toISOString()
  });
  comprobar(
    'un evento con hora anterior al registro del envío se rechaza (422)',
    anterior.http === 422 && anterior.datos.codigo === 'FECHA_INVALIDA',
    anterior.datos
  );
  for (const estado of ['en_transito', 'en_reparto']) {
    const r = await llamar('POST', `/envios/${prepagado.id}/eventos`, token, {
      uuidOperacion: uuid(),
      estado,
      latitud: -12.06,
      longitud: -75.21
    });
    comprobar(`avanza a ${estado}`, r.http === 200 && r.datos.estado === estado, r.datos);
  }
  const directo = await llamar('POST', `/envios/${prepagado.id}/eventos`, token, { uuidOperacion: uuid(), estado: 'entregado' });
  comprobar('"entregado" no se marca sin evidencia (422)', directo.http === 422 && directo.datos.codigo === 'USAR_EVIDENCIA', directo.datos);
  const rutaReparto = await llamar('GET', '/courier/ruta', token);
  comprobar('ya en reparto, pasa a ser parada de entrega', rutaReparto.datos.paradas.some((p) => p.envio.id === prepagado.id && p.tipo === 'entrega'));

  console.log('Entrega con foto y firma (RF-C04, RN-03)');
  const evidencia = { foto: JPEG, firma: PNG, recibeNombre: 'Carlos Mendoza', recibeDni: '45124512', latitud: -12.061, longitud: -75.205 };
  const sinFirma = await llamar('POST', `/envios/${prepagado.id}/evidencia`, token, { ...evidencia, uuidOperacion: uuid(), firma: undefined });
  comprobar('sin firma no se cierra (422)', sinFirma.http === 422 && sinFirma.datos.codigo === 'IMAGEN_REQUERIDA', sinFirma.datos);
  const noImagen = await llamar('POST', `/envios/${prepagado.id}/evidencia`, token, { ...evidencia, uuidOperacion: uuid(), foto: Buffer.from('hola').toString('base64') });
  comprobar('un archivo que no es imagen se rechaza (422)', noImagen.http === 422 && noImagen.datos.codigo === 'IMAGEN_INVALIDA', noImagen.datos);
  const dniMalo = await llamar('POST', `/envios/${prepagado.id}/evidencia`, token, { ...evidencia, uuidOperacion: uuid(), recibeDni: '123' });
  comprobar('el DNI debe tener 8 dígitos (422)', dniMalo.http === 422 && dniMalo.datos.codigo === 'DNI_INVALIDO', dniMalo.datos);
  const entrega = await llamar('POST', `/envios/${prepagado.id}/evidencia`, token, { ...evidencia, uuidOperacion: uuid() });
  comprobar('con foto, firma, nombre y DNI queda ENTREGADO', entrega.http === 201 && entrega.datos.estado === 'entregado', entrega.datos);

  console.log('Contraentrega sin cobro (RN-02)');
  await llamar('POST', `/envios/${contraentrega.id}/eventos`, token, { uuidOperacion: uuid(), estado: 'recogido', guia: contraentrega.numeroGuia });
  await llamar('POST', `/envios/${contraentrega.id}/eventos`, token, { uuidOperacion: uuid(), estado: 'en_transito' });
  await llamar('POST', `/envios/${contraentrega.id}/eventos`, token, { uuidOperacion: uuid(), estado: 'en_reparto' });
  const sinCobro = await llamar('POST', `/envios/${contraentrega.id}/evidencia`, token, { ...evidencia, uuidOperacion: uuid() });
  comprobar('sin cobro confirmado no se entrega un contraentrega (409)', sinCobro.http === 409 && sinCobro.datos.codigo === 'COBRO_PENDIENTE', sinCobro.datos);
  const fallida = await llamar('POST', `/envios/${contraentrega.id}/fallido`, token, { uuidOperacion: uuid(), motivo: 'ausente', foto: JPEG, ...gps });
  comprobar('se registra como entrega fallida con foto de la fachada', fallida.http === 201 && fallida.datos.estado === 'fallido', fallida.datos);

  console.log('El cliente ve la prueba de entrega (HU-R02)');
  const seg = await llamar('GET', `/envios/${prepagado.numeroGuia}`, cliente);
  const prueba = seg.datos?.pruebaEntrega;
  comprobar('el seguimiento trae foto, firma, nombre y la hora', prueba && prueba.fotoUrl && prueba.firmaUrl && prueba.recibeNombre === 'Carlos Mendoza', seg.datos);
  comprobar('el DNI de quien recibe llega oculto al remitente', prueba?.recibeDni === '****4512', prueba);
  const estados = seg.datos.eventos.map((e) => e.estado).join(',');
  comprobar('la línea de tiempo tiene todos los pasos', estados === 'pendiente,recogido,en_transito,en_reparto,entregado', estados);
  comprobar('los eventos del courier traen GPS', seg.datos.eventos.filter((e) => e.estado !== 'pendiente').every((e) => e.latitud !== null));

  const verFoto = async (tk) => {
    const r = await fetch(BASE + prueba.fotoUrl, { headers: { authorization: `Bearer ${tk}` } });
    return { http: r.status, tipo: r.headers.get('content-type') };
  };
  const foto = await verFoto(cliente);
  comprobar('el cliente dueño descarga la foto (image/jpeg)', foto.http === 200 && foto.tipo === 'image/jpeg', foto);
  comprobar('otro cliente no puede ver la foto (403)', (await verFoto(cliente2)).http === 403);
  comprobar('otro courier no puede ver la foto (403)', (await verFoto(tokenOtro)).http === 403);
  comprobar('el operador sí puede verla', (await verFoto(supervisor)).http === 200);

  console.log(`\n${pasos - fallos} de ${pasos} comprobaciones correctas.`);
  process.exit(fallos ? 1 : 0);
})().catch((e) => {
  console.error('La prueba se detuvo:', e.message);
  process.exit(1);
});
