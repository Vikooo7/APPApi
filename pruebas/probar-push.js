// Prueba del registro de celulares para notificaciones push, contra una API local conectada a una COPIA de la base.
// Uso: node pruebas/probar-push.js [http://localhost:3000/api]
// Sin credenciales de Firebase en el servidor, el registro funciona igual y pushActivo viene en false.

const API = process.argv[2] || 'http://localhost:3000/api';
let pasos = 0;
let fallos = 0;

async function llamar(metodo, ruta, token, cuerpo) {
  const r = await fetch(API + ruta, {
    method: metodo,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: cuerpo ? JSON.stringify(cuerpo) : undefined
  });
  return { http: r.status, datos: await r.json().catch(() => null) };
}
async function entrar(correo) {
  return (await llamar('POST', '/auth/login', null, { correo, clave: '1234' })).datos.token;
}
function comprobar(descripcion, condicion, detalle) {
  pasos += 1;
  if (condicion) console.log(`  ✔ ${descripcion}`);
  else {
    fallos += 1;
    console.log(`  ✖ ${descripcion}`, detalle !== undefined ? JSON.stringify(detalle) : '');
  }
}

(async () => {
  console.log(`API: ${API}`);
  const cliente = await entrar('cliente@rutalog.pe');
  const cliente2 = await entrar('cliente2@rutalog.pe');
  const token = `prueba-fcm-${crypto.randomUUID()}-${'x'.repeat(40)}`;

  comprobar('sin sesión no se registra (401)', (await llamar('POST', '/dispositivos', null, { token })).http === 401);
  comprobar('un token inválido se rechaza (422)', (await llamar('POST', '/dispositivos', cliente, { token: 'corto' })).http === 422);
  comprobar('una app desconocida se rechaza (422)', (await llamar('POST', '/dispositivos', cliente, { token, app: 'otra' })).http === 422);
  const r = await llamar('POST', '/dispositivos', cliente, { token, app: 'cliente' });
  comprobar('el remitente registra su celular', r.http === 201 && r.datos.registrado === true && typeof r.datos.pushActivo === 'boolean', r.datos);
  comprobar('registrarlo otra vez no falla (mismo token)', (await llamar('POST', '/dispositivos', cliente, { token })).http === 201);
  comprobar('si otra persona entra en ese celular, el token pasa a ser suyo', (await llamar('POST', '/dispositivos', cliente2, { token })).http === 201);
  comprobar('al cerrar sesión se borra (204)', (await llamar('DELETE', '/dispositivos', cliente2, { token })).http === 204);
  console.log(`  (push con credenciales de Firebase en este servidor: ${r.datos?.pushActivo ? 'sí' : 'no'})`);

  console.log(`\n${pasos - fallos} de ${pasos} comprobaciones correctas.`);
  process.exitCode = fallos ? 1 : 0;
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
