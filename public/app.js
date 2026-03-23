// --- Supabase client ---
const SUPABASE_URL = 'https://ojdzccddsoktdfhzuwki.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9qZHpjY2Rkc29rdGRmaHp1d2tpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQyMDkxODIsImV4cCI6MjA4OTc4NTE4Mn0.VFUim58h4y_hXF240CC7wUh_rSvSHWiLXfzkOuug8Xg';
const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// --- Estado ---
let planActual = 'gratis';
let usosActual = 0;
let limiteActual = 5;
let authMode = 'login'; // 'login' o 'register'

// --- Al cargar ---
document.addEventListener('DOMContentLoaded', async () => {
  const { data: { session } } = await sb.auth.getSession();
  if (session) {
    document.getElementById('landing').classList.add('oculto');
    await mostrarApp(session);

    // Si viene de Mercado Pago, verificar pago
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('from') === 'mp' || urlParams.get('preapproval_id') || document.referrer.includes('mercadopago')) {
      window.history.replaceState({}, '', '/');
      await verificarPago();
    }
  } else {
    document.getElementById('landing').classList.remove('oculto');
  }
});

// --- Ir al login desde la landing ---
function irALogin() {
  document.getElementById('landing').classList.add('oculto');
  document.getElementById('auth-screen').classList.remove('oculto');
}

// --- Auth: login con Google ---
async function loginConGoogle() {
  const { error } = await sb.auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo: window.location.origin
    }
  });

  if (error) {
    const errorDiv = document.getElementById('auth-error');
    errorDiv.textContent = 'Error al conectar con Google. Intenta de nuevo.';
    errorDiv.classList.remove('oculto');
  }
}

// --- Mostrar la app despues del login ---
async function mostrarApp(session) {
  document.getElementById('auth-screen').classList.add('oculto');
  document.getElementById('app').classList.remove('oculto');
  await cargarUsuario();
}

// --- Obtener token ---
async function getToken() {
  const { data: { session } } = await sb.auth.getSession();
  return session?.access_token;
}

// --- Fetch autenticado ---
async function fetchAuth(url, options = {}) {
  const token = await getToken();
  return fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
      ...(options.headers || {})
    }
  });
}

// --- Cargar usuario ---
async function cargarUsuario() {
  try {
    const res = await fetchAuth('/usuario');
    const data = await res.json();
    if (data.ok === false) return;
    actualizarUI(data);
  } catch (err) {
    console.error('Error cargando usuario:', err);
  }
}

// --- Actualizar UI ---
function actualizarUI(data) {
  planActual = data.plan;
  usosActual = data.usosEsteMes;
  limiteActual = data.limiteMensual;

  const badge = document.getElementById('plan-badge');
  if (data.plan === 'pro') {
    badge.textContent = 'PRO';
    badge.style.background = 'linear-gradient(135deg, #10b981, #059669)';
  } else if (data.plan === 'basico') {
    badge.textContent = 'BASICO';
    badge.style.background = 'linear-gradient(135deg, #3b82f6, #8b5cf6)';
  } else {
    badge.textContent = 'GRATIS';
    badge.style.background = 'rgba(255,255,255,0.15)';
  }

  const label = document.getElementById('uso-label');
  const count = document.getElementById('uso-count');
  const fill = document.getElementById('uso-bar-fill');

  if (data.limiteMensual === null) {
    label.textContent = 'Respuestas usadas este mes';
    count.textContent = `${data.usosEsteMes} (ilimitadas)`;
    fill.style.width = '100%';
    fill.style.background = 'linear-gradient(90deg, #10b981, #059669)';
  } else {
    const pct = Math.min((data.usosEsteMes / data.limiteMensual) * 100, 100);
    label.textContent = 'Respuestas usadas este mes';
    count.textContent = `${data.usosEsteMes} / ${data.limiteMensual}`;
    fill.style.width = pct + '%';

    if (pct >= 90) fill.style.background = 'linear-gradient(90deg, #ef4444, #dc2626)';
    else if (pct >= 70) fill.style.background = 'linear-gradient(90deg, #f59e0b, #d97706)';
    else fill.style.background = 'linear-gradient(90deg, #3b82f6, #8b5cf6)';
  }

  actualizarCardsModal();
}

// --- Generar respuestas ---
async function generar() {
  const mensaje = document.getElementById('mensaje').value.trim();
  const tono = document.getElementById('tono').value;
  const largo = document.getElementById('largo').value;
  const nombreNegocio = document.getElementById('nombre-negocio').value.trim();
  const tipoNegocio = document.getElementById('tipo-negocio').value.trim();
  const palabrasClave = document.getElementById('palabras-clave').value.trim();
  const idioma = document.getElementById('idioma').value;

  if (!mensaje) {
    mostrarError('Escribi o pega el mensaje del cliente antes de generar.');
    return;
  }

  document.getElementById('respuestas').classList.add('oculto');
  document.getElementById('error').classList.add('oculto');
  document.getElementById('loading').classList.remove('oculto');
  document.getElementById('btn-generar').disabled = true;

  try {
    const res = await fetchAuth('/generar', {
      method: 'POST',
      body: JSON.stringify({ mensaje, tono, largo, nombreNegocio, tipoNegocio, palabrasClave, idioma })
    });

    const data = await res.json();

    if (!data.ok) {
      mostrarError(data.error);
      return;
    }

    mostrarRespuestas(data.respuestas);
    actualizarUI({ plan: data.plan, usosEsteMes: data.usosEsteMes, limiteMensual: data.limiteMensual });

  } catch (err) {
    mostrarError('Error de conexion. Intenta de nuevo.');
  } finally {
    document.getElementById('loading').classList.add('oculto');
    document.getElementById('btn-generar').disabled = false;
  }
}

// --- Mostrar respuestas ---
function mostrarRespuestas(respuestas) {
  const contenedor = document.getElementById('lista-respuestas');
  contenedor.innerHTML = '';

  respuestas.forEach((texto, i) => {
    const card = document.createElement('div');
    card.className = 'respuesta-card';
    card.innerHTML = `
      <div class="respuesta-numero">${i + 1}</div>
      <div class="respuesta-contenido">
        <p class="respuesta-texto">${texto}</p>
        <div class="respuesta-btns">
          <button class="btn-copiar" onclick="copiar(this, ${i})">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
            </svg>
            Copiar
          </button>
          <button class="btn-wsp" onclick="enviarWhatsApp(${i})">
            <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z"/><path d="M12 0C5.373 0 0 5.373 0 12c0 2.625.846 5.059 2.284 7.034L.789 23.492l4.638-1.522A11.953 11.953 0 0012 24c6.627 0 12-5.373 12-12S18.627 0 12 0zm0 21.75c-2.14 0-4.144-.67-5.804-1.823l-.416-.27-2.75.903.879-2.682-.293-.437A9.725 9.725 0 012.25 12c0-5.385 4.365-9.75 9.75-9.75s9.75 4.365 9.75 9.75-4.365 9.75-9.75 9.75z"/></svg>
            WhatsApp
          </button>
        </div>
      </div>
    `;
    contenedor.appendChild(card);
  });

  document.getElementById('respuestas').classList.remove('oculto');
}

// --- Enviar por WhatsApp ---
function enviarWhatsApp(index) {
  const texto = document.querySelectorAll('.respuesta-texto')[index].textContent;
  const url = `https://wa.me/?text=${encodeURIComponent(texto)}`;
  window.open(url, '_blank');
}

// --- Enviar por WhatsApp desde historial ---
function enviarWhatsAppTexto(texto) {
  window.open(`https://wa.me/?text=${encodeURIComponent(texto)}`, '_blank');
}

// --- Copiar ---
async function copiar(btn, index) {
  const texto = document.querySelectorAll('.respuesta-texto')[index].textContent;
  try { await navigator.clipboard.writeText(texto); } catch (err) {
    const ta = document.createElement('textarea'); ta.value = texto;
    document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta);
  }
  btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M20 6L9 17l-5-5"></path></svg> Copiado!`;
  btn.classList.add('copiado');
  setTimeout(() => {
    btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg> Copiar`;
    btn.classList.remove('copiado');
  }, 2000);
}

// --- Errores ---
function mostrarError(mensaje) {
  const errorDiv = document.getElementById('error');
  errorDiv.textContent = mensaje;
  errorDiv.classList.remove('oculto');
}

// --- Modal de planes ---
function abrirPlanes() {
  actualizarCardsModal();
  document.getElementById('modal-planes').classList.remove('oculto');
  document.body.style.overflow = 'hidden';
}

function cerrarPlanes() {
  document.getElementById('modal-planes').classList.add('oculto');
  document.body.style.overflow = '';
}

function cerrarPlanesOverlay(e) { if (e.target === e.currentTarget) cerrarPlanes(); }

function actualizarCardsModal() {
  const cards = {
    gratis: document.getElementById('card-gratis'),
    basico: document.getElementById('card-basico'),
    pro: document.getElementById('card-pro')
  };
  if (!cards.gratis || !cards.basico || !cards.pro) return;

  const labels = { gratis: 'Seleccionar Gratis', basico: 'Seleccionar Basico', pro: 'Seleccionar Pro' };
  for (const [plan, card] of Object.entries(cards)) {
    const btn = card.querySelector('.plan-btn');
    card.classList.toggle('activo', planActual === plan);
    if (planActual === plan) {
      btn.textContent = 'Plan actual';
      btn.classList.add('plan-activo-btn');
    } else {
      btn.textContent = labels[plan];
      btn.classList.remove('plan-activo-btn');
    }
  }
}

async function seleccionarPlan(plan) {
  if (plan === planActual) return;

  // Si es plan gratis, cambiar directo
  if (plan === 'gratis') {
    try {
      const res = await fetchAuth('/cambiar-plan', {
        method: 'POST',
        body: JSON.stringify({ plan: 'gratis' })
      });
      const data = await res.json();
      if (data.ok) {
        actualizarUI({ plan: data.plan, usosEsteMes: data.usosEsteMes, limiteMensual: data.limiteMensual });
        cerrarPlanes();
      }
    } catch (err) { mostrarError('Error al cambiar el plan.'); }
    return;
  }

  // Para planes pagos, redirigir a Mercado Pago
  try {
    const btn = document.querySelector(`#card-${plan} .plan-btn`);
    btn.textContent = 'Redirigiendo...';
    btn.disabled = true;

    const res = await fetchAuth('/suscribir', {
      method: 'POST',
      body: JSON.stringify({ plan })
    });
    const data = await res.json();

    if (data.ok && data.url) {
      window.location.href = data.url;
    } else {
      mostrarError(data.error || 'Error al crear suscripcion.');
      btn.textContent = plan === 'basico' ? 'Seleccionar Basico' : 'Seleccionar Pro';
      btn.disabled = false;
    }
  } catch (err) {
    mostrarError('Error al conectar con Mercado Pago.');
  }
}

// --- Logout ---
async function logout() {
  await sb.auth.signOut();
  document.getElementById('app').classList.add('oculto');
  document.getElementById('landing').classList.remove('oculto');
}

// --- Historial ---
async function abrirHistorial() {
  document.querySelector('.formulario').classList.add('oculto');
  document.getElementById('respuestas').classList.add('oculto');
  document.getElementById('loading').classList.add('oculto');
  document.getElementById('error').classList.add('oculto');
  document.getElementById('uso-bar-section').classList.add('oculto');
  document.getElementById('historial-section').classList.remove('oculto');
  await cargarHistorial();
}

function cerrarHistorial() {
  document.getElementById('historial-section').classList.add('oculto');
  document.querySelector('.formulario').classList.remove('oculto');
  document.getElementById('uso-bar-section').classList.remove('oculto');
}

async function cargarHistorial() {
  const loadingDiv = document.getElementById('historial-loading');
  const vacioDiv = document.getElementById('historial-vacio');
  const listaDiv = document.getElementById('lista-historial');

  loadingDiv.classList.remove('oculto');
  vacioDiv.classList.add('oculto');
  listaDiv.innerHTML = '';

  try {
    const res = await fetchAuth('/historial');
    const data = await res.json();
    loadingDiv.classList.add('oculto');

    if (!data.ok || !data.historial || data.historial.length === 0) {
      vacioDiv.classList.remove('oculto');
      return;
    }

    data.historial.forEach(item => {
      listaDiv.appendChild(crearCardHistorial(item));
    });
  } catch (err) {
    loadingDiv.classList.add('oculto');
    vacioDiv.classList.remove('oculto');
  }
}

function escapeHTML(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function crearCardHistorial(item) {
  const card = document.createElement('div');
  card.className = 'historial-card';
  card.id = `historial-${item.id}`;

  const fecha = new Date(item.created_at).toLocaleDateString('es-AR', {
    day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit'
  });

  const meta = [item.tono, item.largo];
  if (item.nombre_negocio) meta.push(item.nombre_negocio);
  if (item.tipo_negocio) meta.push(item.tipo_negocio);

  let respHTML = '';
  item.respuestas.forEach((resp, i) => {
    respHTML += `
      <div class="historial-respuesta">
        <div class="respuesta-numero">${i + 1}</div>
        <div class="respuesta-contenido">
          <p class="respuesta-texto">${escapeHTML(resp)}</p>
          <div class="respuesta-btns">
            <button class="btn-copiar" onclick="copiarTexto(this, '${escapeHTML(resp).replace(/'/g, "\\'")}')">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
              </svg>
              Copiar
            </button>
            <button class="btn-wsp" onclick="enviarWhatsAppTexto('${escapeHTML(resp).replace(/'/g, "\\'")}')">
              <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z"/><path d="M12 0C5.373 0 0 5.373 0 12c0 2.625.846 5.059 2.284 7.034L.789 23.492l4.638-1.522A11.953 11.953 0 0012 24c6.627 0 12-5.373 12-12S18.627 0 12 0zm0 21.75c-2.14 0-4.144-.67-5.804-1.823l-.416-.27-2.75.903.879-2.682-.293-.437A9.725 9.725 0 012.25 12c0-5.385 4.365-9.75 9.75-9.75s9.75 4.365 9.75 9.75-4.365 9.75-9.75 9.75z"/></svg>
              WhatsApp
            </button>
          </div>
        </div>
      </div>`;
  });

  card.innerHTML = `
    <div class="historial-card-header">
      <div class="historial-meta">
        <span class="historial-fecha">${fecha}</span>
        <span class="historial-tags">${meta.join(' / ')}</span>
      </div>
      <button class="btn-eliminar-historial" onclick="eliminarHistorial('${item.id}')">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
          <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
        </svg>
      </button>
    </div>
    <div class="historial-mensaje">
      <span class="historial-label">Mensaje del cliente:</span>
      <p>"${escapeHTML(item.mensaje_cliente)}"</p>
    </div>
    <div class="historial-respuestas">${respHTML}</div>
  `;

  return card;
}

async function copiarTexto(btn, texto) {
  try { await navigator.clipboard.writeText(texto); } catch (err) {
    const ta = document.createElement('textarea'); ta.value = texto;
    document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta);
  }
  btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M20 6L9 17l-5-5"></path></svg> Copiado!`;
  btn.classList.add('copiado');
  setTimeout(() => {
    btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg> Copiar`;
    btn.classList.remove('copiado');
  }, 2000);
}

async function eliminarHistorial(id) {
  try {
    const res = await fetchAuth(`/historial/${id}`, { method: 'DELETE' });
    const data = await res.json();
    if (data.ok) {
      const card = document.getElementById(`historial-${id}`);
      card.style.opacity = '0';
      card.style.transform = 'translateY(-10px)';
      card.style.transition = 'all 0.3s';
      setTimeout(() => {
        card.remove();
        if (document.getElementById('lista-historial').children.length === 0) {
          document.getElementById('historial-vacio').classList.remove('oculto');
        }
      }, 300);
    }
  } catch (err) {
    mostrarError('Error al eliminar del historial.');
  }
}

// --- Filtrar historial por busqueda y categoria ---
function filtrarHistorial() {
  const query = document.getElementById('historial-search').value.toLowerCase();
  const tonoFiltro = document.getElementById('historial-filtro-tono').value.toLowerCase();
  const cards = document.querySelectorAll('.historial-card');

  cards.forEach(card => {
    const texto = card.textContent.toLowerCase();
    const tags = card.querySelector('.historial-tags')?.textContent.toLowerCase() || '';
    const matchTexto = !query || texto.includes(query);
    const matchTono = !tonoFiltro || tags.includes(tonoFiltro);
    card.style.display = (matchTexto && matchTono) ? '' : 'none';
  });
}

// --- Verificar pago de MP ---
async function verificarPago() {
  try {
    const res = await fetchAuth('/verificar-pago', { method: 'POST' });
    const data = await res.json();
    if (data.actualizado) {
      await cargarUsuario();
    }
  } catch (err) {
    console.error('Error verificando pago:', err);
  }
}

// --- Escape para cerrar modal ---
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') cerrarPlanes(); });
