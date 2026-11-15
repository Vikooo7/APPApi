// Prueba de punta a punta de lo nuevo de la App Cliente contra una API local conectada a una COPIA de la base.
// Uso: node --env-file=.env servidor-local.js   (en otra terminal)
//      node pruebas/probar-cliente.js [http://localhost:3000/api]
// Usa las cuentas de ejemplo (clave 1234). No ejecutar contra la base real: crea envíos.

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
const guiaNueva = () => `RLP-26-${String(Math.floor(700000 + Math.random() * 99999))}-0`;

(async () => {
  console.log(`API: ${API}`);
  const cliente = await entrar('cliente@rutalog.pe');
  const otroCliente = await entrar('cliente2@rutalog.pe');
  const supervisor = await entrar('supervisor@rutalog.pe');

  console.log('Registrar envío (HU-R01)');
  const sinDestinatario = await llamar('POST', '/envios', cliente, {
    uuidOperacion: uuid(),
    uuid: uuid(),
    numeroGuia: guiaNueva(),
    ruta: 'Lima → Ica',
    pesoKg: 2
  });
  comprobar('la App Cliente del parcial sigue registrando (sin destinatario)', sinDestinatario.http === 201, sinDestinatario.datos);

  const datos = {
    uuidOperacion: uuid(),
    uuid: uuid(),
    numeroGuia: guiaNueva(),
    ruta: 'Lima → Huancayo',
    pesoKg: 1.2,
    destinatarioNombre: 'Carlos Mendoza',
    destinatarioTelefono: '987654321',
    destinatarioDireccion: 'Av. Huancavelica 512, El Tambo',
    montoContraentrega: 189
  };
  const creado = await llamar('POST', '/envios', cliente, datos);
  comprobar(
    'registra destinatario y contraentrega de S/ 189',
    creado.http === 201 && creado.datos.montoContraentrega === 189 && creado.datos.destinatarioNombre === 'Carlos Mendoza',
    creado.datos
  );
  const repetido = await llamar('POST', '/envios', cliente, datos);
  comprobar('reenviar la misma operación no duplica', repetido.http === 201 && repetido.datos.duplicado === true, repetido.datos);

  const malos = [
    [{ montoContraentrega: 50, destinatarioNombre: null, destinatarioDireccion: null }, 'DESTINATARIO_INVALIDO', 'contraentrega sin destinatario'],
    [{ destinatarioTelefono: '123' }, 'TELEFONO_INVALIDO', 'celular inválido'],
    [{ montoContraentrega: -1 }, 'MONTO_INVALIDO', 'monto negativo'],
    [{ pesoKg: 0 }, 'PESO_INVALIDO', 'peso 0 (regla del parcial)']
  ];
  for (const [cambio, codigo, descripcion] of malos) {
    const r = await llamar('POST', '/envios', cliente, { ...datos, uuidOperacion: uuid(), uuid: uuid(), numeroGuia: guiaNueva(), ...cambio });
    comprobar(`rechaza ${descripcion} (422)`, r.http === 422 && r.datos.codigo === codigo, r.datos);
  }

  console.log('Editar mientras sigue pendiente');
  const editado = await llamar('PUT', `/envios/${creado.datos.id}`, cliente, {
    uuidOperacion: uuid(),
    ruta: creado.datos.ruta,
    pesoKg: 1.5,
    montoContraentrega: 210,
    version: creado.datos.version
  });
  comprobar(
    'cambia monto y peso, y conserva el destinatario',
    editado.http === 200 && editado.datos.montoContraentrega === 210 && editado.datos.destinatarioNombre === 'Carlos Mendoza',
    editado.datos
  );
  const soloRutaPeso = await llamar('PUT', `/envios/${creado.datos.id}`, cliente, {
    uuidOperacion: uuid(),
    ruta: creado.datos.ruta,
    pesoKg: 1.6,
    version: editado.datos.version
  });
  comprobar('la edición del parcial (solo ruta y peso) no borra el contraentrega', soloRutaPeso.datos?.montoContraentrega === 210, soloRutaPeso.datos);

  console.log('Seguimiento por guía (HU-R02)');
  const guia = creado.datos.numeroGuia;
  const seg = await llamar('GET', `/envios/${encodeURIComponent(guia)}`, cliente);
  comprobar(
    'devuelve el envío, sus eventos y la prueba de entrega',
    seg.http === 200 && seg.datos.envio.numeroGuia === guia && Array.isArray(seg.datos.eventos) && 'pruebaEntrega' in seg.datos,
    seg.datos
  );
  comprobar('el primer evento es "registrado" (pendiente) con su hora', seg.datos.eventos[0]?.estado === 'pendiente' && seg.datos.eventos[0]?.fechaHora, seg.datos.eventos);
  comprobar('aún sin entregar, no hay prueba de entrega', seg.datos.pruebaEntrega === null, seg.datos.pruebaEntrega);
  comprobar('la guía se acepta en minúsculas', (await llamar('GET', `/envios/${guia.toLowerCase()}`, cliente)).http === 200);
  comprobar('otro cliente no ve el seguimiento (403)', (await llamar('GET', `/envios/${guia}`, otroCliente)).http === 403);
  comprobar('una guía que no existe da 404', (await llamar('GET', '/envios/RLP-26-000000-0', cliente)).http === 404);
  comprobar('por número sigue devolviendo solo el envío', (await llamar('GET', `/envios/${creado.datos.id}`, cliente)).datos?.numeroGuia === guia);

  console.log('El seguimiento refleja lo que hace la operación');
  const couriers = (await llamar('GET', '/couriers', supervisor)).datos.datos;
  const libre = couriers.sort((a, b) => b.disponibles - a.disponibles)[0];
  const recogido = await llamar('PUT', `/envios/${creado.datos.id}`, supervisor, {
    uuidOperacion: uuid(),
    estado: 'recogido',
    courierId: libre.id,
    version: soloRutaPeso.datos.version
  });
  comprobar('el operador lo pasa a recogido', recogido.http === 200, recogido.datos);
  const seg2 = await llamar('GET', `/envios/${guia}`, cliente);
  comprobar(
    'la línea de tiempo del cliente ya muestra "recogido"',
    seg2.datos.eventos.map((e) => e.estado).join(',') === 'pendiente,recogido',
    seg2.datos.eventos
  );
  const tarde = await llamar('PUT', `/envios/${creado.datos.id}`, cliente, {
    uuidOperacion: uuid(),
    ruta: creado.datos.ruta,
    pesoKg: 3,
    version: recogido.datos.version
  });
  comprobar('ya recogido, el cliente no puede editarlo (409)', tarde.http === 409 && tarde.datos.codigo === 'ENVIO_NO_EDITABLE', tarde.datos);

  console.log(`\n${pasos - fallos} de ${pasos} comprobaciones correctas.`);
  process.exit(fallos ? 1 : 0);
})().catch((e) => {
  console.error('La prueba se detuvo:', e.message);
  process.exit(1);
});
