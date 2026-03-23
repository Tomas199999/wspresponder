require('dotenv').config();
const express = require('express');
const path = require('path');
const OpenAI = require('openai');
const { createClient } = require('@supabase/supabase-js');

const deepseek = new OpenAI({
  baseURL: 'https://api.deepseek.com',
  apiKey: process.env.DEEPSEEK_API_KEY
});

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

const app = express();
const PORT = 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PLANES = {
  gratis:  { nombre: 'Gratis',  precio: '$0',     limiteMensual: 5 },
  basico:  { nombre: 'Basico',  precio: '$4.990', limiteMensual: 50 },
  pro:     { nombre: 'Pro',     precio: '$9.990', limiteMensual: null }
};

const MP_PLANES = {
  basico: 'd603aa00ba6c44a3bfd89f7a38399ada',
  pro: 'a4c458e17db641579b90be324a3f21a5'
};

// --- Middleware: verificar autenticacion ---
async function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) {
    return res.status(401).json({ ok: false, error: 'No autenticado.' });
  }

  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) {
    return res.status(401).json({ ok: false, error: 'Token invalido.' });
  }

  req.user = user;
  next();
}

// --- Endpoint: obtener datos del usuario ---
app.get('/usuario', authMiddleware, async (req, res) => {
  const perfil = await obtenerPerfil(req.user.id);
  if (!perfil) {
    return res.status(404).json({ ok: false, error: 'Perfil no encontrado.' });
  }

  const planInfo = PLANES[perfil.plan] || PLANES.gratis;
  res.json({
    email: perfil.email,
    plan: perfil.plan,
    planNombre: planInfo.nombre,
    precio: planInfo.precio,
    usosEsteMes: perfil.usos_este_mes,
    limiteMensual: planInfo.limiteMensual
  });
});

// --- Endpoint: obtener URL de suscripcion ---
app.post('/suscribir', authMiddleware, async (req, res) => {
  const { plan } = req.body;
  if (!MP_PLANES[plan]) {
    return res.status(400).json({ ok: false, error: 'Plan invalido.' });
  }

  // Guardar plan pendiente antes de redirigir
  await supabase.from('perfiles')
    .update({ plan_pendiente: plan })
    .eq('id', req.user.id);

  const url = `https://www.mercadopago.com.ar/subscriptions/checkout?preapproval_plan_id=${MP_PLANES[plan]}`;
  res.json({ ok: true, url });
});

// --- Endpoint: verificar pago despues de volver de MP ---
app.post('/verificar-pago', authMiddleware, async (req, res) => {
  const perfil = await obtenerPerfil(req.user.id);
  if (!perfil.plan_pendiente) {
    return res.json({ ok: true, actualizado: false });
  }

  try {
    // Buscar suscripciones autorizadas recientes
    const response = await fetch('https://api.mercadopago.com/preapproval/search?status=authorized&sort=date_created&criteria=desc&limit=10', {
      headers: { 'Authorization': `Bearer ${process.env.MP_ACCESS_TOKEN}` }
    });
    const data = await response.json();

    // Buscar el monto que corresponde al plan pendiente
    const montos = { basico: 4990, pro: 9990 };
    const montoEsperado = montos[perfil.plan_pendiente];

    // Buscar suscripcion reciente (ultimos 10 min) con ese monto
    const ahora = new Date();
    const sub = data.results?.find(s => {
      const creada = new Date(s.date_created);
      const diffMin = (ahora - creada) / 1000 / 60;
      return s.auto_recurring?.transaction_amount === montoEsperado && diffMin < 30;
    });

    if (sub) {
      await supabase.from('perfiles')
        .update({ plan: perfil.plan_pendiente, plan_pendiente: null })
        .eq('id', req.user.id);
      console.log(`Plan verificado y actualizado a ${perfil.plan_pendiente} para ${perfil.email}`);
      return res.json({ ok: true, actualizado: true, plan: perfil.plan_pendiente });
    }

    res.json({ ok: true, actualizado: false });
  } catch (err) {
    console.error('Error verificando pago:', err.message);
    res.json({ ok: true, actualizado: false });
  }
});

// --- Webhook de Mercado Pago ---
app.post('/webhook/mp', async (req, res) => {
  res.status(200).send('OK');

  const { type, data } = req.body;
  console.log('Webhook recibido:', type, data?.id);
  if (!data?.id) return;
  if (type !== 'subscription_preapproval' && type !== 'subscription_authorized_payment') return;

  try {
    const response = await fetch(`https://api.mercadopago.com/preapproval/${data.id}`, {
      headers: { 'Authorization': `Bearer ${process.env.MP_ACCESS_TOKEN}` }
    });
    const sub = await response.json();
    console.log('Sub status:', sub.status, 'ref:', sub.external_reference, 'email:', sub.payer_email);

    // Determinar el plan segun el monto
    let plan = 'gratis';
    const monto = sub.auto_recurring?.transaction_amount;
    if (monto === 4990) plan = 'basico';
    else if (monto === 9990) plan = 'pro';

    // Buscar usuario por external_reference o email
    let userId = null;
    if (sub.external_reference) {
      userId = sub.external_reference.split('|')[0];
    } else if (sub.payer_email) {
      const { data: perfil } = await supabase.from('perfiles').select('id').eq('email', sub.payer_email).single();
      if (perfil) userId = perfil.id;
    }

    if (!userId) {
      console.log('No se pudo encontrar usuario para la suscripcion');
      return;
    }

    if (sub.status === 'authorized') {
      await supabase.from('perfiles').update({ plan }).eq('id', userId);
      console.log(`Plan actualizado a ${plan} para ${userId}`);
    } else if (sub.status === 'cancelled' || sub.status === 'paused') {
      await supabase.from('perfiles').update({ plan: 'gratis' }).eq('id', userId);
      console.log(`Plan revertido a gratis para ${userId}`);
    }
  } catch (err) {
    console.error('Error webhook:', err.message);
  }
});

// --- Endpoint: cambiar plan (manual, para downgrade a gratis) ---
app.post('/cambiar-plan', authMiddleware, async (req, res) => {
  const { plan } = req.body;
  if (plan !== 'gratis') {
    return res.status(400).json({ ok: false, error: 'Para planes pagos usa la suscripcion.' });
  }

  const { error } = await supabase
    .from('perfiles')
    .update({ plan: 'gratis' })
    .eq('id', req.user.id);

  if (error) {
    return res.status(500).json({ ok: false, error: 'Error al cambiar plan.' });
  }

  const perfil = await obtenerPerfil(req.user.id);
  const planInfo = PLANES[perfil.plan];
  res.json({
    ok: true,
    plan: perfil.plan,
    planNombre: planInfo.nombre,
    precio: planInfo.precio,
    usosEsteMes: perfil.usos_este_mes,
    limiteMensual: planInfo.limiteMensual
  });
});

// --- Endpoint: generar respuestas ---
app.post('/generar', authMiddleware, async (req, res) => {
  const { mensaje, tono, nombreNegocio, tipoNegocio, largo, palabrasClave, idioma } = req.body;

  if (!mensaje || !tono) {
    return res.status(400).json({ ok: false, error: 'El mensaje y el tono son obligatorios.' });
  }

  // Filtro de contenido inapropiado
  if (filtroContenido(mensaje) || filtroContenido(palabrasClave || '')) {
    return res.status(400).json({ ok: false, error: 'El mensaje contiene contenido no permitido. Esta herramienta es solo para respuestas de ventas.' });
  }

  const perfil = await obtenerPerfil(req.user.id);
  const planInfo = PLANES[perfil.plan] || PLANES.gratis;

  if (planInfo.limiteMensual !== null && perfil.usos_este_mes >= planInfo.limiteMensual) {
    return res.status(403).json({
      ok: false,
      error: `Llegaste al limite de tu plan (${planInfo.limiteMensual} respuestas). Mejora tu plan para seguir generando \uD83D\uDE80`
    });
  }

  try {
    const respuestas = await generarConIA(mensaje, tono, nombreNegocio, tipoNegocio, largo || 'media', palabrasClave, idioma);

    // Incrementar usos en la base de datos
    await supabase
      .from('perfiles')
      .update({ usos_este_mes: perfil.usos_este_mes + 1 })
      .eq('id', req.user.id);

    // Guardar en historial
    const { error: histError } = await supabase.from('historial').insert({
      user_id: req.user.id,
      mensaje_cliente: mensaje,
      tono,
      largo: largo || 'media',
      nombre_negocio: nombreNegocio || null,
      tipo_negocio: tipoNegocio || null,
      palabras_clave: palabrasClave || null,
      respuestas
    });
    if (histError) console.error('Error historial:', histError);

    res.json({
      ok: true,
      respuestas,
      plan: perfil.plan,
      usosEsteMes: perfil.usos_este_mes + 1,
      limiteMensual: planInfo.limiteMensual
    });
  } catch (err) {
    console.error('Error con DeepSeek:', err.message);
    res.status(500).json({ ok: false, error: 'Error al generar respuestas. Intenta de nuevo.' });
  }
});

// --- Endpoint: obtener historial ---
app.get('/historial', authMiddleware, async (req, res) => {
  const { data, error } = await supabase
    .from('historial')
    .select('*')
    .eq('user_id', req.user.id)
    .order('created_at', { ascending: false })
    .limit(50);

  if (error) {
    return res.status(500).json({ ok: false, error: 'Error al cargar el historial.' });
  }

  res.json({ ok: true, historial: data });
});

// --- Endpoint: eliminar del historial ---
app.delete('/historial/:id', authMiddleware, async (req, res) => {
  const { error } = await supabase
    .from('historial')
    .delete()
    .eq('id', req.params.id)
    .eq('user_id', req.user.id);

  if (error) {
    return res.status(500).json({ ok: false, error: 'Error al eliminar.' });
  }

  res.json({ ok: true });
});

// --- Obtener perfil con reset mensual ---
async function obtenerPerfil(userId) {
  const { data, error } = await supabase
    .from('perfiles')
    .select('*')
    .eq('id', userId)
    .single();

  if (error || !data) return null;

  // Reset mensual: si cambio el mes, reiniciar contador
  const mesActual = new Date().toISOString().slice(0, 7); // '2026-03'
  if (data.mes_actual !== mesActual) {
    await supabase
      .from('perfiles')
      .update({ usos_este_mes: 0, mes_actual: mesActual })
      .eq('id', userId);
    data.usos_este_mes = 0;
    data.mes_actual = mesActual;
  }

  return data;
}

// --- Filtro de contenido inapropiado ---
function filtroContenido(texto) {
  const prohibido = [
    'bomba', 'explosivo', 'arma', 'droga', 'matar', 'asesinar', 'suicid',
    'terroris', 'hackear', 'robar', 'estafa', 'ilegal', 'narco',
    'pornograf', 'sexual', 'menor', 'pedof', 'violacion', 'violar',
    'lavado de dinero', 'falsific', 'secuestr', 'extorsion', 'amenaz',
    'veneno', 'cianuro', 'rifle', 'pistola', 'municion', 'cocaina',
    'marihuana', 'metanfetamina', 'heroina', 'trafico'
  ];
  const lower = texto.toLowerCase();
  return prohibido.some(p => lower.includes(p));
}

// --- Generador de respuestas con DeepSeek ---
async function generarConIA(mensaje, tono, nombreNegocio, tipoNegocio, largo, palabrasClave, idioma) {
  let negocioTexto = '';
  if (nombreNegocio && tipoNegocio) {
    negocioTexto = `El negocio se llama "${nombreNegocio}" y es un/a ${tipoNegocio}.`;
  } else if (nombreNegocio) {
    negocioTexto = `El negocio se llama "${nombreNegocio}".`;
  } else if (tipoNegocio) {
    negocioTexto = `El negocio es un/a ${tipoNegocio}.`;
  }

  const largos = {
    corta: 'Cada respuesta debe tener maximo 1 linea (una oracion corta).',
    media: 'Cada respuesta debe tener maximo 2 lineas.',
    larga: 'Cada respuesta puede tener entre 3 y 5 lineas, con mas detalle y argumentos de venta.'
  };

  let keywordsTexto = '';
  if (palabrasClave) {
    keywordsTexto = `\nIMPORTANTE: Incluir naturalmente estas palabras o conceptos en las respuestas: ${palabrasClave}`;
  }

  const idiomas = {
    espanol_argentino: 'Responde en español argentino (voseo, modismos argentinos).',
    espanol: 'Responde en español neutro.',
    portugues: 'Responde en portugués brasileño.',
    ingles: 'Responde en inglés.',
    italiano: 'Responde en italiano.',
    frances: 'Responde en francés.'
  };
  const idiomaTexto = idiomas[idioma] || idiomas.espanol_argentino;

  const prompt = `Actua como un experto en ventas por mensajeria.
Genera exactamente 3 respuestas diferentes para responder al mensaje de un cliente.

REGLAS:
- ${idiomaTexto}
- Las respuestas deben ser naturales, humanas y persuasivas.
- Usa tono ${tono}.
- ${largos[largo] || largos.media}
- Incluir una pregunta para continuar la conversacion cuando sea posible.
- No uses asteriscos, negritas ni formato especial. Solo texto plano.
- No numeres las respuestas.
- Separa cada respuesta con el separador: |||
${negocioTexto ? '- ' + negocioTexto : ''}${keywordsTexto}

Mensaje del cliente: "${mensaje}"

Responde SOLO con las 3 respuestas separadas por ||| sin nada mas.`;

  const completion = await deepseek.chat.completions.create({
    model: 'deepseek-chat',
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.8,
    max_tokens: 1000
  });

  const texto = completion.choices[0].message.content.trim();
  const respuestas = texto.split('|||').map(r => r.trim()).filter(r => r.length > 0);

  while (respuestas.length < 3) {
    respuestas.push(respuestas[0] || 'Hola! En que te podemos ayudar?');
  }

  return respuestas.slice(0, 3);
}

// Local development
if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT, () => {
    console.log(`MensajesIA corriendo en http://localhost:${PORT}`);
  });
}

module.exports = app;
