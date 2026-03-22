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

  // Guardar que plan quiere el usuario para asociarlo despues
  await supabase.from('perfiles')
    .update({ plan_pendiente: plan })
    .eq('id', req.user.id);

  const url = `https://www.mercadopago.com.ar/subscriptions/checkout?preapproval_plan_id=${MP_PLANES[plan]}`;
  res.json({ ok: true, url });
});

// --- Webhook de Mercado Pago ---
app.post('/webhook/mp', async (req, res) => {
  res.status(200).send('OK');

  const { type, data } = req.body;
  if (type !== 'subscription_preapproval' || !data?.id) return;

  try {
    const response = await fetch(`https://api.mercadopago.com/preapproval/${data.id}`, {
      headers: { 'Authorization': `Bearer ${process.env.MP_ACCESS_TOKEN}` }
    });
    const sub = await response.json();
    const payerEmail = sub.payer_email;
    if (!payerEmail) return;

    // Determinar el plan segun el monto
    let plan = 'gratis';
    if (sub.auto_recurring?.transaction_amount === 4990) plan = 'basico';
    else if (sub.auto_recurring?.transaction_amount === 9990) plan = 'pro';

    if (sub.status === 'authorized') {
      await supabase.from('perfiles').update({ plan }).eq('email', payerEmail);
      console.log(`Plan actualizado a ${plan} para ${payerEmail}`);
    } else if (sub.status === 'cancelled' || sub.status === 'paused') {
      await supabase.from('perfiles').update({ plan: 'gratis' }).eq('email', payerEmail);
      console.log(`Plan revertido a gratis para ${payerEmail}`);
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
  const { mensaje, tono, nombreNegocio, tipoNegocio, largo, palabrasClave } = req.body;

  if (!mensaje || !tono) {
    return res.status(400).json({ ok: false, error: 'El mensaje y el tono son obligatorios.' });
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
    const respuestas = await generarConIA(mensaje, tono, nombreNegocio, tipoNegocio, largo || 'media', palabrasClave);

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

// --- Generador de respuestas con DeepSeek ---
async function generarConIA(mensaje, tono, nombreNegocio, tipoNegocio, largo, palabrasClave) {
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

  const prompt = `Actua como un experto en ventas por WhatsApp en Argentina.
Genera exactamente 3 respuestas diferentes para responder al mensaje de un cliente.

REGLAS:
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
    console.log(`MensajeAI corriendo en http://localhost:${PORT}`);
  });
}

module.exports = app;
