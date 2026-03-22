require('dotenv').config();
const express = require('express');
const path = require('path');
const OpenAI = require('openai');

const deepseek = new OpenAI({
  baseURL: 'https://api.deepseek.com',
  apiKey: process.env.DEEPSEEK_API_KEY
});

const app = express();
const PORT = 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- Estado del usuario (simulado en memoria) ---
const PLANES = {
  gratis:  { nombre: 'Gratis',  precio: '$0',     limiteMensual: 5 },
  basico:  { nombre: 'Basico',  precio: '$4.990', limiteMensual: 50 },
  pro:     { nombre: 'Pro',     precio: '$9.990', limiteMensual: null }
};

const usuario = {
  nombre: 'Usuario Demo',
  plan: 'gratis',
  usosEsteMes: 0
};

// --- Endpoint: obtener datos del usuario ---
app.get('/usuario', (req, res) => {
  const planInfo = PLANES[usuario.plan];
  res.json({
    nombre: usuario.nombre,
    plan: usuario.plan,
    planNombre: planInfo.nombre,
    precio: planInfo.precio,
    usosEsteMes: usuario.usosEsteMes,
    limiteMensual: planInfo.limiteMensual
  });
});

// --- Endpoint: cambiar plan ---
app.post('/cambiar-plan', (req, res) => {
  const { plan } = req.body;
  if (!PLANES[plan]) {
    return res.status(400).json({ ok: false, error: 'Plan invalido.' });
  }
  usuario.plan = plan;
  const planInfo = PLANES[plan];
  res.json({
    ok: true,
    plan: usuario.plan,
    planNombre: planInfo.nombre,
    precio: planInfo.precio,
    usosEsteMes: usuario.usosEsteMes,
    limiteMensual: planInfo.limiteMensual
  });
});

// --- Endpoint: generar respuestas ---
app.post('/generar', async (req, res) => {
  const { mensaje, tono, nombreNegocio, tipoNegocio, largo, palabrasClave } = req.body;

  if (!mensaje || !tono) {
    return res.status(400).json({ ok: false, error: 'El mensaje y el tono son obligatorios.' });
  }

  const planInfo = PLANES[usuario.plan];
  if (planInfo.limiteMensual !== null && usuario.usosEsteMes >= planInfo.limiteMensual) {
    return res.status(403).json({
      ok: false,
      error: `Llegaste al limite de tu plan (${planInfo.limiteMensual} respuestas). Mejora tu plan para seguir generando \uD83D\uDE80`
    });
  }

  try {
    const respuestas = await generarConIA(mensaje, tono, nombreNegocio, tipoNegocio, largo || 'media', palabrasClave);
    usuario.usosEsteMes++;

    res.json({
      ok: true,
      respuestas,
      usosEsteMes: usuario.usosEsteMes,
      limiteMensual: PLANES[usuario.plan].limiteMensual
    });
  } catch (err) {
    console.error('Error con Gemini:', err.message);
    res.status(500).json({ ok: false, error: 'Error al generar respuestas. Intenta de nuevo.' });
  }
});

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

  // Parsear las 3 respuestas
  const respuestas = texto.split('|||').map(r => r.trim()).filter(r => r.length > 0);

  // Asegurar que siempre devolvemos exactamente 3
  while (respuestas.length < 3) {
    respuestas.push(respuestas[0] || 'Hola! En que te podemos ayudar?');
  }

  return respuestas.slice(0, 3);
}

app.listen(PORT, () => {
  console.log(`WspResponder corriendo en http://localhost:${PORT}`);
});
