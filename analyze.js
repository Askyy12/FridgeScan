// api/analyze.js
// Serverless function (Vercel).
// STEP 1: Gemini guarda la foto e riconosce gli ingredienti (italiano + inglese).
// STEP 2: Spoonacular cerca ricette REALI usando quegli ingredienti.
// Le chiavi GEMINI_API_KEY e SPOONACULAR_API_KEY restano SOLO qui, mai esposte al browser.

// --- Rate limit "best effort" in memoria ---
// ATTENZIONE: su Vercel ogni funzione serverless può girare su istanze diverse,
// quindi questo contatore NON è perfettamente affidabile (si azzera se cambia istanza).
// Per un limite serio e persistente serve un DB esterno gratuito tipo Upstash Redis
// (vedi note in fondo al file). Per iniziare, questo basta a scoraggiare l'abuso banale.
const hits = new Map(); // ip -> { count, day }

function getToday() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

const DAILY_LIMIT = 5; // scansioni gratuite per IP al giorno

function checkRateLimit(ip) {
  const today = getToday();
  const entry = hits.get(ip);
  if (!entry || entry.day !== today) {
    hits.set(ip, { count: 1, day: today });
    return { allowed: true, remaining: DAILY_LIMIT - 1 };
  }
  if (entry.count >= DAILY_LIMIT) {
    return { allowed: false, remaining: 0 };
  }
  entry.count += 1;
  return { allowed: true, remaining: DAILY_LIMIT - entry.count };
}

// Prompt Gemini: SOLO riconoscimento ingredienti, niente ricette (ora le fa Spoonacular)
const PROMPT = `Guarda questa immagine di un frigorifero, una dispensa o del cibo in casa.
Elenca tutti gli alimenti e ingredienti che riesci a identificare chiaramente (massimo 50).
Rispondi ESCLUSIVAMENTE con un oggetto JSON valido, nessun testo prima o dopo, nessun blocco markdown, con esattamente questa struttura:
{"ingredients": ["nome in italiano", "..."], "ingredientsEn": ["english name", "..."]}
Gli array "ingredients" e "ingredientsEn" devono avere la stessa lunghezza e essere nello stesso ordine (stesso ingrediente, due lingue).
Usa nomi semplici e generici in inglese per ingredientsEn (es. "tomato" non "cherry tomato on the vine"), utili per una ricerca ricette.
Se l'immagine non mostra chiaramente del cibo o ingredienti riconoscibili, rispondi invece con:
{"error": "spiegazione breve in italiano del problema"}`;

async function recognizeIngredients(apiKey, mediaType, base64) {
  const geminiResp = await fetch(
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey
      },
      body: JSON.stringify({
        contents: [
          {
            role: 'user',
            parts: [
              { inline_data: { mime_type: mediaType, data: base64 } },
              { text: PROMPT }
            ]
          }
        ]
      })
    }
  );

  if (!geminiResp.ok) {
    const errText = await geminiResp.text();
    console.error('Gemini API error:', geminiResp.status, errText);
    throw new Error('GEMINI_ERROR');
  }

  const data = await geminiResp.json();
  const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
  const cleaned = text.replace(/```json|```/g, '').trim();

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    console.error('JSON non valido da Gemini:', text);
    throw new Error('GEMINI_PARSE_ERROR');
  }

  return parsed;
}

// Difficoltà stimata dal tempo di preparazione (Spoonacular non fornisce una difficoltà diretta)
function estimateDifficulty(minutes) {
  if (minutes == null) return 'Media';
  if (minutes <= 20) return 'Facile';
  if (minutes <= 45) return 'Media';
  return 'Difficile';
}

async function findRecipes(apiKey, ingredientsEn) {
  const query = encodeURIComponent(ingredientsEn.join(','));
  const url = `https://api.spoonacular.com/recipes/complexSearch?includeIngredients=${query}&fillIngredients=true&addRecipeInformation=true&sort=min-missing-ingredients&number=3`;

  const resp = await fetch(url, {
    headers: { 'x-api-key': apiKey }
  });

  if (!resp.ok) {
    const errText = await resp.text();
    console.error('Spoonacular API error:', resp.status, errText);
    throw new Error('SPOONACULAR_ERROR');
  }

  const data = await resp.json();
  const results = data?.results || [];

  return results.map((r) => {
    const steps = (r.analyzedInstructions?.[0]?.steps || [])
      .slice(0, 4)
      .map(s => s.step);

    return {
      title: r.title,
      time: r.readyInMinutes ? `${r.readyInMinutes} min` : '',
      difficulty: estimateDifficulty(r.readyInMinutes),
      usedIngredients: (r.usedIngredients || []).map(i => i.name || i.original),
      missingIngredients: (r.missedIngredients || []).map(i => i.name || i.original),
      steps
    };
  });
}

module.exports = async (req, res) => {
  // CORS base (utile se un giorno servi il frontend da un dominio diverso)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Metodo non permesso' });
  }

  const geminiKey = process.env.GEMINI_API_KEY;
  if (!geminiKey) {
    return res.status(500).json({ error: 'Chiave Gemini non configurata sul server.' });
  }

  const spoonacularKey = process.env.SPOONACULAR_API_KEY;
  if (!spoonacularKey) {
    return res.status(500).json({ error: 'Chiave Spoonacular non configurata sul server.' });
  }

  // Identifica l'IP (Vercel mette l'IP reale in x-forwarded-for)
  const ip = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown')
    .toString()
    .split(',')[0]
    .trim();

  const rl = checkRateLimit(ip);
  if (!rl.allowed) {
    return res.status(429).json({
      error: `Hai raggiunto il limite di ${DAILY_LIMIT} scansioni gratuite oggi. Riprova domani!`
    });
  }

  const { mediaType, base64 } = req.body || {};
  if (!mediaType || !base64) {
    return res.status(400).json({ error: 'Immagine mancante o non valida.' });
  }

  try {
    // STEP 1: riconoscimento ingredienti con Gemini
    const recognized = await recognizeIngredients(geminiKey, mediaType, base64);

    if (recognized.error) {
      return res.status(200).json({ error: recognized.error });
    }

    const ingredients = recognized.ingredients || [];
    const ingredientsEn = recognized.ingredientsEn || [];

    if (ingredients.length === 0 || ingredientsEn.length === 0) {
      return res.status(200).json({ error: 'Non sono riuscito a riconoscere ingredienti nella foto.' });
    }

    // STEP 2: ricerca ricette reali con Spoonacular
    const recipes = await findRecipes(spoonacularKey, ingredientsEn);

    return res.status(200).json({ ingredients, recipes, remaining: rl.remaining });
  } catch (err) {
    console.error('Errore analyze:', err);
    if (err.message === 'GEMINI_ERROR' || err.message === 'GEMINI_PARSE_ERROR') {
      return res.status(502).json({ error: 'Non sono riuscito ad analizzare la foto. Prova con più luce e a fuoco.' });
    }
    if (err.message === 'SPOONACULAR_ERROR') {
      return res.status(502).json({ error: 'Errore nel cercare le ricette. Riprova tra poco.' });
    }
    return res.status(500).json({ error: 'Errore interno del server.' });
  }
};

/*
NOTE PER SCALARE IN FUTURO:
- Il rate limit in memoria qui sopra si resetta quando Vercel riavvia/cambia istanza
  della funzione. Va bene per partire, ma un utente "furbo" potrebbe fare più richieste
  di quelle previste. Per un limite solido e persistente:
    1. Crea un account gratuito su https://upstash.com (Redis serverless, free tier generoso)
    2. npm install @upstash/redis
    3. Sostituisci la Map con chiamate a redis.incr(`ip:${ip}:${today}`) e redis.expire(...)
- Se un giorno vuoi limitare per account invece che per IP, aggiungi un sistema di login
  (es. NextAuth, Clerk, o anche solo un semplice localStorage + captcha per bot).
- Spoonacular free tier: 150 richieste/giorno totali per la tua chiave (non per utente).
  Ogni analisi foto = 1 chiamata Spoonacular. Monitora l'uso su spoonacular.com/food-api/console.
- Titoli e passaggi delle ricette Spoonacular sono in INGLESE (il loro database è in inglese).
  Se vuoi tradurli in italiano, si può aggiungere uno STEP 3 con Gemini che traduce
  il risultato prima di rispondere al frontend (costa un'altra chiamata API + qualche secondo in più).
*/
