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

const PROMPT = `Guarda questa immagine di un frigorifero, una dispensa o del cibo in casa.
Elenca tutti gli alimenti e ingredienti che riesci a identificare chiaramente (massimo 50 anche se di solito ce ne sono meno).
Poi, usando SOLO quegli ingredienti (puoi dare per scontato che sale, pepe, olio d'oliva e acqua siano sempre disponibili), proponi fino a 3 ricette realizzabili, dalla più semplice alla più elaborata.
Per ogni ricetta indica: titolo, tempo di preparazione stimato, difficoltà (Facile/Media/Difficile), gli ingredienti visti che usa, eventuali ingredienti mancanti da comprare, e massimo 4 passaggi brevi (una frase corta ciascuno).
Rispondi ESCLUSIVAMENTE con un oggetto JSON valido, nessun testo prima o dopo, nessun blocco markdown, con esattamente questa struttura:
{"ingredients": ["..."], "recipes": [{"title": "...", "time": "...", "difficulty": "...", "usedIngredients": ["..."], "missingIngredients": ["..."], "steps": ["..."]}]}
Se l'immagine non mostra chiaramente del cibo o ingredienti riconoscibili, rispondi invece con:
{"error": "spiegazione breve in italiano del problema"}`;

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

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'Chiave Gemini non configurata sul server.' });
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
      return res.status(502).json({ error: 'Errore nel contattare il modello AI. Riprova tra poco.' });
    }

    const data = await geminiResp.json();
    const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
    const cleaned = text.replace(/```json|```/g, '').trim();

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (e) {
      console.error('JSON non valido dal modello:', text);
      return res.status(502).json({ error: 'Non sono riuscito ad analizzare la foto. Prova con più luce e a fuoco.' });
    }

    return res.status(200).json({ ...parsed, remaining: rl.remaining });
  } catch (err) {
    console.error('Errore analyze:', err);
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
*/
