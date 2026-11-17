// Web del comité de créditos de Banco Andino (RN-08: el crédito lo aprueba el comité en la web).
// Página estática sin dependencias: pide la clave del comité, lista las solicitudes y permite decidir.
const PAGINA_COMITE = `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Comité de créditos · Banco Andino</title>
<style>
  :root { --azul:#0b3d91; --azul2:#1565c0; --fondo:#f4f6fa; --texto:#1b2333; --suave:#5b6578; --borde:#dde3ee;
          --ok:#2e7d32; --mal:#c62828; --tarjeta:#fff; }
  @media (prefers-color-scheme: dark) {
    :root { --fondo:#0f1420; --texto:#e8ecf4; --suave:#9aa5ba; --borde:#2a3347; --tarjeta:#171e2d; }
  }
  * { box-sizing:border-box; }
  body { margin:0; font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; background:var(--fondo); color:var(--texto); }
  header { background:linear-gradient(135deg,var(--azul),var(--azul2)); color:#fff; padding:22px 16px; }
  header h1 { margin:0; font-size:20px; } header p { margin:4px 0 0; opacity:.85; font-size:14px; }
  main { max-width:880px; margin:0 auto; padding:16px; }
  .tarjeta { background:var(--tarjeta); border:1px solid var(--borde); border-radius:14px; padding:16px; margin-bottom:14px; }
  label { font-size:13px; color:var(--suave); display:block; margin-bottom:4px; }
  input, textarea { width:100%; padding:10px; border-radius:10px; border:1px solid var(--borde); background:transparent; color:var(--texto); font:inherit; }
  button { border:0; border-radius:10px; padding:10px 14px; font:inherit; font-weight:600; cursor:pointer; color:#fff; background:var(--azul2); }
  button.ok { background:var(--ok); } button.mal { background:var(--mal); } button:disabled { opacity:.5; cursor:default; }
  .fila { display:flex; gap:10px; flex-wrap:wrap; align-items:end; }
  .fila > div { flex:1 1 200px; }
  .estado { display:inline-block; padding:3px 10px; border-radius:999px; font-size:12px; font-weight:700; }
  .EN_EVALUACION { background:#fff3cd; color:#7a5a00; } .DESEMBOLSADO { background:#d7f3dc; color:#1b5e20; } .RECHAZADO { background:#fde0e0; color:#8e1b1b; }
  table { width:100%; border-collapse:collapse; font-size:13px; margin-top:8px; }
  th, td { text-align:left; padding:6px 4px; border-bottom:1px solid var(--borde); }
  td.num, th.num { text-align:right; font-variant-numeric:tabular-nums; }
  .suave { color:var(--suave); font-size:13px; } .error { color:var(--mal); } .grande { font-size:22px; font-weight:700; }
</style>
</head>
<body>
<header><h1>Banco Andino · Comité de créditos</h1><p>Evaluación de solicitudes con la facturación autorizada por la empresa (datos simulados).</p></header>
<main>
  <div class="tarjeta" id="acceso">
    <div class="fila">
      <div><label for="clave">Clave del comité</label><input id="clave" type="password" autocomplete="current-password"></div>
      <button id="entrar">Ver solicitudes</button>
    </div>
    <p class="suave">Solo se comparten totales por mes (facturación y número de envíos), nunca datos de los clientes de la empresa.</p>
    <p id="msg" class="error"></p>
  </div>
  <div id="lista"></div>
</main>
<script>
const $ = (s) => document.querySelector(s);
const soles = (n) => 'S/ ' + Number(n).toLocaleString('es-PE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
let clave = sessionStorage.getItem('comite') || '';
if (clave) { $('#clave').value = clave; cargar(); }
$('#entrar').onclick = () => { clave = $('#clave').value; sessionStorage.setItem('comite', clave); cargar(); };

async function api(ruta, opciones = {}) {
  const r = await fetch('/banco/api' + ruta, { ...opciones, headers: { 'content-type': 'application/json', 'x-comite-clave': clave } });
  const datos = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(datos.mensaje || 'Error ' + r.status);
  return datos;
}

async function cargar() {
  $('#msg').textContent = '';
  try {
    const creditos = await api('/comite/creditos');
    pintar(creditos);
  } catch (e) { $('#msg').textContent = e.message; $('#lista').innerHTML = ''; }
}

function esc(t) { return String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }

function pintar(creditos) {
  if (!creditos.length) { $('#lista').innerHTML = '<div class="tarjeta suave">No hay solicitudes todavía.</div>'; return; }
  $('#lista').innerHTML = creditos.map((c) => {
    const prom = c.facturacion.length ? c.facturacion.reduce((s, f) => s + f.facturacion, 0) / c.facturacion.length : 0;
    const filas = c.facturacion.map((f) => '<tr><td>' + esc(f.mes) + '</td><td class="num">' + soles(f.facturacion) + '</td><td class="num">' + f.envios + '</td></tr>').join('');
    const decidir = c.estado === 'EN_EVALUACION'
      ? '<div class="fila" style="margin-top:12px"><div><label>Comentario</label><input id="com-' + c.id + '" placeholder="Opcional"></div>' +
        '<button class="ok" onclick="decidir(\\'' + c.id + '\\',\\'APROBADO\\')">Aprobar y desembolsar</button>' +
        '<button class="mal" onclick="decidir(\\'' + c.id + '\\',\\'RECHAZADO\\')">Rechazar</button></div>'
      : '<p class="suave">' + (c.nroDesembolso ? 'Desembolsado · ' + esc(c.nroDesembolso) + ' · cuota ' + soles(c.cuota) + ' x ' + c.plazoMeses + ' meses' : '') +
        (c.comentario ? ' · ' + esc(c.comentario) : '') + '</p>';
    return '<div class="tarjeta"><div class="fila" style="justify-content:space-between"><div><strong>' + esc(c.id) + ' · ' + esc(c.solicitante) +
      '</strong><div class="suave">' + esc(c.proposito) + '</div></div><span class="estado ' + c.estado + '">' + c.estado.replace('_', ' ') + '</span></div>' +
      '<div class="fila" style="margin-top:10px"><div><span class="suave">Monto</span><div class="grande">' + soles(c.monto) + '</div></div>' +
      '<div><span class="suave">Plazo</span><div class="grande">' + c.plazoMeses + ' meses</div></div>' +
      '<div><span class="suave">Facturación promedio</span><div class="grande">' + soles(prom) + ' / mes</div></div></div>' +
      '<table><thead><tr><th>Mes</th><th class="num">Facturación</th><th class="num">Envíos</th></tr></thead><tbody>' + filas + '</tbody></table>' + decidir + '</div>';
  }).join('');
}

async function decidir(id, decision) {
  if (!confirm((decision === 'APROBADO' ? '¿Aprobar y desembolsar ' : '¿Rechazar ') + id + '?')) return;
  try {
    await api('/comite/creditos/' + id, { method: 'POST', body: JSON.stringify({ decision, comentario: $('#com-' + id).value }) });
    cargar();
  } catch (e) { alert(e.message); }
}
</script>
</body>
</html>`;

module.exports = { PAGINA_COMITE };
