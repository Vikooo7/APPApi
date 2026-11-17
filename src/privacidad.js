// Ética del caso: "el courier ve solo nombre, dirección y teléfono del destinatario, y solo durante la entrega".
// Se aplica a todas las respuestas que recibe un courier (ruta, eventos, evidencia, fallidas, conflictos y
// respuestas repetidas por idempotencia), para que ningún endpoint nuevo se olvide de filtrar.

/** Estados en los que el courier está entregando: solo entonces ve los datos del destinatario. */
const ESTADOS_DE_ENTREGA = new Set(['en_reparto', 'reprogramado']);
const CAMPOS_DESTINATARIO = ['destinatarioNombre', 'destinatarioTelefono', 'destinatarioDireccion'];

/** Devuelve una copia del cuerpo sin los datos del destinatario en los envíos que no están en reparto. */
function ocultarDestinatario(valor) {
  if (Array.isArray(valor)) return valor.map(ocultarDestinatario);
  if (!valor || typeof valor !== 'object' || valor instanceof Date) return valor;
  const copia = {};
  for (const [clave, v] of Object.entries(valor)) copia[clave] = ocultarDestinatario(v);
  const esEnvio = typeof copia.numeroGuia === 'string' && typeof copia.estado === 'string';
  if (esEnvio && CAMPOS_DESTINATARIO.some((c) => c in copia) && !ESTADOS_DE_ENTREGA.has(copia.estado)) {
    for (const campo of CAMPOS_DESTINATARIO) if (campo in copia) copia[campo] = null;
  }
  return copia;
}

/** Middleware: filtra res.json cuando quien llama es un courier (req.usuario lo deja requiereSesion). */
function privacidadCourier(req, res, next) {
  const json = res.json.bind(res);
  res.json = (cuerpo) => json(req.usuario?.rol === 'courier' ? ocultarDestinatario(cuerpo) : cuerpo);
  next();
}

module.exports = { privacidadCourier, ocultarDestinatario, ESTADOS_DE_ENTREGA };
