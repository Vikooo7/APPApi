// Notificaciones push en tiempo real con Firebase Cloud Messaging (FCM, API HTTP v1).
//
// Cuando el courier avanza un envío (recoge, sale a reparto, entrega, no pudo entregar, cobra), la API envía
// una notificación al celular del remitente aunque la App Cliente esté cerrada. La app registra su token en
// POST /api/dispositivos al iniciar sesión.
//
// Credenciales (solo en el servidor, nunca en las apps): la cuenta de servicio del proyecto de Firebase, en
//  - FIREBASE_SERVICE_ACCOUNT: el JSON de la cuenta de servicio, tal cual o en base64 (variable de Vercel), o
//  - GOOGLE_APPLICATION_CREDENTIALS: la ruta al archivo JSON (para probar en la PC).
// Sin credenciales no se envía nada y la API sigue funcionando: la App Cliente se entera al sincronizar.
const fs = require('fs');
const jwt = require('jsonwebtoken');
const { consulta } = require('./db');

const ALCANCE = 'https://www.googleapis.com/auth/firebase.messaging';
const TIEMPO_MAXIMO_MS = 4000;
const CANAL_ANDROID = 'envios_tiempo_real'; // el mismo canal (importancia alta) que crea la App Cliente

let credenciales; // undefined = sin leer; null = no configuradas
let acceso = null; // { token, venceEn }

function leerCredenciales() {
  if (credenciales !== undefined) return credenciales;
  try {
    let texto = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!texto && process.env.GOOGLE_APPLICATION_CREDENTIALS) {
      texto = fs.readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS, 'utf8');
    }
    if (!texto) return (credenciales = null);
    texto = texto.trim();
    if (!texto.startsWith('{')) texto = Buffer.from(texto, 'base64').toString('utf8');
    const c = JSON.parse(texto);
    credenciales = c.client_email && c.private_key && c.project_id ? c : null;
  } catch (e) {
    console.error('Push: las credenciales de Firebase no son válidas.');
    credenciales = null;
  }
  return credenciales;
}

const pushConfigurado = () => Boolean(leerCredenciales());

/** Token de acceso de Google (OAuth 2 con la cuenta de servicio). Se reutiliza hasta un minuto antes de vencer. */
async function tokenDeAcceso(c) {
  if (acceso && acceso.venceEn - 60_000 > Date.now()) return acceso.token;
  const urlToken = c.token_uri || 'https://oauth2.googleapis.com/token';
  const afirmacion = jwt.sign({ scope: ALCANCE }, c.private_key, {
    algorithm: 'RS256', issuer: c.client_email, audience: urlToken, expiresIn: 3600
  });
  const r = await fetch(urlToken, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: afirmacion }),
    signal: AbortSignal.timeout(TIEMPO_MAXIMO_MS)
  });
  if (!r.ok) throw new Error(`Google respondió ${r.status} al pedir el token de FCM`);
  const datos = await r.json();
  acceso = { token: datos.access_token, venceEn: Date.now() + Number(datos.expires_in || 3600) * 1000 };
  return acceso.token;
}

/** Hora de Lima "10:32" de una fecha. */
function horaLima(fecha) {
  const d = new Date(new Date(fecha || Date.now()).getTime() - 5 * 3600 * 1000);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

const MOTIVOS = {
  ausente: 'no había nadie para recibir',
  direccion_errada: 'la dirección no es correcta',
  rechazado: 'el destinatario lo rechazó',
  zona_inaccesible: 'no se pudo llegar a la zona'
};

/**
 * Texto de la notificación según lo que hizo el courier. [extra]: fecha (hora real del evento), motivo,
 * intento, recibeNombre, monto, nroOperacion. Devuelve null si ese estado no se avisa.
 */
function avisoDeEstado(envio, estado, extra = {}) {
  const guia = envio.numero_guia;
  const hora = horaLima(extra.fecha);
  const destino = String(envio.ruta || '').split('→').pop().trim();
  const textos = {
    recogido: ['El courier recogió tu envío', `${guia} fue recogido a las ${hora}. Va camino a ${destino}.`],
    en_transito: ['Tu envío va en camino', `${guia} salió hacia ${destino} (${hora}).`],
    en_reparto: ['Tu envío salió a reparto', `${guia} llega hoy a ${envio.destinatario_nombre || 'su destinatario'}.`],
    entregado: ['Envío entregado', `${guia} se entregó a las ${hora}${extra.recibeNombre ? ` · recibió ${extra.recibeNombre}` : ''}. Mira la foto y la firma en el seguimiento.`],
    fallido: ['No se pudo entregar', `${guia}: ${MOTIVOS[extra.motivo] || 'la entrega falló'} (intento ${extra.intento || 1} de 3, ${hora}). Le avisamos al destinatario para reprogramar.`],
    devuelto: ['Tu envío vuelve a ti', `${guia} no pudo entregarse tras 3 intentos y regresa al remitente.`],
    reprogramado: ['Entrega reprogramada', `${guia} vuelve a salir a reparto.`],
    cobrado: ['Cobro contraentrega confirmado', `El destinatario pagó S/ ${Number(extra.monto || 0).toFixed(2)} de ${guia} · operación ${extra.nroOperacion}. Se te liquida el martes o viernes.`]
  };
  const t = textos[estado];
  if (!t) return null;
  return { usuarioId: envio.usuario_id, titulo: t[0], cuerpo: t[1], datos: { tipo: 'estado', guia, estado } };
}

/** Envía un aviso a todos los celulares del usuario en la app indicada. Nunca lanza error. */
async function notificarUsuario(aviso, app = 'cliente') {
  const c = leerCredenciales();
  if (!c || !aviso) return 0;
  let enviados = 0;
  try {
    const { rows } = await consulta('SELECT token FROM dispositivos WHERE usuario_id = $1 AND app = $2', [aviso.usuarioId, app]);
    if (rows.length === 0) return 0;
    const token = await tokenDeAcceso(c);
    const url = `https://fcm.googleapis.com/v1/projects/${c.project_id}/messages:send`;
    await Promise.all(rows.map(async ({ token: destino }) => {
      const datos = Object.fromEntries(Object.entries({ ...aviso.datos, titulo: aviso.titulo, cuerpo: aviso.cuerpo }).map(([k, v]) => [k, String(v)]));
      const r = await fetch(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          message: {
            token: destino,
            notification: { title: aviso.titulo, body: aviso.cuerpo },
            data: datos,
            // Prioridad alta y el mismo "tag" que usa la app: si luego sincroniza, reemplaza esta notificación en vez de duplicarla.
            android: { priority: 'HIGH', notification: { channel_id: CANAL_ANDROID, tag: aviso.datos?.guia || 'rutalog' } }
          }
        }),
        signal: AbortSignal.timeout(TIEMPO_MAXIMO_MS)
      }).catch(() => null);
      if (r?.ok) {
        enviados += 1;
      } else if (r && (r.status === 404 || r.status === 400)) {
        // El token ya no existe (la app se desinstaló o cerró sesión en ese celular): se olvida.
        await consulta('DELETE FROM dispositivos WHERE token = $1', [destino]).catch(() => {});
      }
    }));
  } catch (e) {
    console.error('Push no enviado:', e.message);
  }
  return enviados;
}

/** Envía varios avisos (los junta una operación) sin demorar más de unos segundos. */
async function enviarAvisos(avisos) {
  const validos = (avisos || []).filter(Boolean);
  if (validos.length === 0 || !pushConfigurado()) return;
  await Promise.all(validos.map((a) => notificarUsuario(a)));
}

module.exports = { avisoDeEstado, notificarUsuario, enviarAvisos, pushConfigurado, horaLima };
