// api/ai.js
// CareerMitra AI backend (Vercel Serverless Function)
//
// One job: take the prompt that index.html has already built (it contains the
// student's Personal Vault, test answers, family answers, etc.), send it to an
// AI model, and return clean JSON. All prompt design, validation and the
// neutrality checks live in index.html. This file does NOT replace the client's
// questions with its own, so the Test Zone now really comes from the AI.
//
// Handles: rate limits (429) with retry + model rotation, timeouts, invalid JSON,
// optional live web search (for the "Research this career" button).

export const maxDuration = 60;

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

const PRIMARY_MODEL =
  process.env.OPENROUTER_MODEL || "nvidia/nemotron-3-ultra-550b-a55b:free";

const MODELS = [
  process.env.OPENROUTER_TEST_MODEL,
  PRIMARY_MODEL,
  "nvidia/nemotron-3-super-120b-a12b:free",
  "nvidia/nemotron-3.5-lightning:free",
  "openrouter/free"
].filter((v, i, a) => v && a.indexOf(v) === i);

const TIME_BUDGET_MS = 56000;   // Vercel limit is 60s
const MAX_ATTEMPTS = 6;
const MAX_PROMPT_CHARS = 60000;

const SYSTEM_PROMPT = `You are the AI engine of CareerMitra, a career guidance app for Indian students and their families.
Principles you always follow:
- Be completely neutral. No career, stream, degree, job type, salary level or lifestyle is better than another.
- Use ONLY the information given in the request. Never invent facts about the person.
- Be polite, humble, soft-spoken and encouraging. Use simple, easy English.
- Never pressure anyone and never say what a person "should" choose.
- When evidence is weak or mixed, say so honestly.
- Follow the requested output format exactly. Return ONLY valid JSON, with no markdown and no text outside the JSON.`;

// ------------------------------------------------------------------ helpers

const sleep = ms => new Promise(r => setTimeout(r, Math.max(0, ms)));

function safeJsonParse(text) {
  if (!text) return null;
  let raw = String(text).trim();
  raw = raw.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/i, "").trim();
  try { return JSON.parse(raw); } catch {}
  const first = raw.indexOf("{");
  const last = raw.lastIndexOf("}");
  if (first >= 0 && last > first) {
    try { return JSON.parse(raw.slice(first, last + 1)); } catch {}
  }
  return null;
}

function extractCitations(message) {
  const out = [];
  const seen = new Set();
  const list = Array.isArray(message && message.annotations) ? message.annotations : [];
  for (const a of list) {
    const c = a && a.type === "url_citation" ? a.url_citation || a : null;
    const url = c && String(c.url || "").trim();
    if (!url || seen.has(url) || !/^https?:\/\//i.test(url)) continue;
    seen.add(url);
    out.push({
      title: String(c.title || url).slice(0, 160),
      url,
      snippet: String(c.content || c.snippet || "").replace(/\s+/g, " ").trim().slice(0, 260)
    });
  }
  return out.slice(0, 8);
}

// ------------------------------------------------------------------ AI call

async function requestAI({ prompt, webSearch }) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    const e = new Error("OPENROUTER_API_KEY is missing on the server.");
    e.status = 500;
    throw e;
  }

  const started = Date.now();
  let useJsonMode = true;
  let usePlugin = !!webSearch;
  let lastError = null;
  let lastStatus = 0;
  let retryAfter = 0;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const remaining = TIME_BUDGET_MS - (Date.now() - started);
    if (remaining < 5000) break;

    const model = MODELS[attempt % MODELS.length];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(remaining - 1000, 46000));

    try {
      const body = {
        model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: prompt }
        ],
        temperature: webSearch ? 0.3 : 0.6,
        max_tokens: 7000
      };
      if (useJsonMode) body.response_format = { type: "json_object" };
      if (usePlugin) body.plugins = [{ id: "web", max_results: 6 }];

      const response = await fetch(OPENROUTER_URL, {
        method: "POST",
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": process.env.APP_URL || "https://careermitra.vercel.app",
          "X-Title": "CareerMitra"
        },
        body: JSON.stringify(body)
      });

      const text = await response.text();
      lastStatus = response.status;

      if (!response.ok) {
        lastError = new Error(`AI provider error ${response.status}: ${text.slice(0, 300)}`);

        if (response.status === 429) {
          retryAfter = Number(response.headers.get("retry-after")) || retryAfter || 3;
          // next attempt uses a different model, so a short pause is enough
          await sleep(Math.min(retryAfter * 1000, 2500));
          continue;
        }
        // Model does not support JSON mode / web plugin -> retry without it
        if ([400, 402, 404, 422].includes(response.status)) {
          if (usePlugin && /plugin|web|credit|search/i.test(text)) { usePlugin = false; attempt--; continue; }
          if (useJsonMode && /response_format|json/i.test(text)) { useJsonMode = false; attempt--; continue; }
          if (usePlugin) { usePlugin = false; attempt--; continue; }
        }
        await sleep(400 * (attempt + 1));
        continue;
      }

      const json = safeJsonParse(text);
      const message = json && json.choices && json.choices[0] && json.choices[0].message;
      const content = message && typeof message.content === "string" ? message.content : "";
      if (!content.trim()) {
        lastError = new Error("AI returned empty content.");
        await sleep(400 * (attempt + 1));
        continue;
      }

      const data = safeJsonParse(content);
      if (!data || typeof data !== "object" || Array.isArray(data)) {
        lastError = new Error("AI returned invalid JSON.");
        await sleep(300 * (attempt + 1));
        continue;
      }

      return {
        data,
        model,
        attempts: attempt + 1,
        citations: usePlugin ? extractCitations(message) : [],
        webSearchUsed: !!usePlugin
      };
    } catch (error) {
      lastError = error && error.name === "AbortError" ? new Error("AI took too long to answer.") : error;
      await sleep(400 * (attempt + 1));
    } finally {
      clearTimeout(timer);
    }
  }

  const err = lastError || new Error("AI request failed.");
  err.status = lastStatus === 429 ? 429 : 503;
  err.retryAfter = retryAfter;
  throw err;
}

// ------------------------------------------------------------------ handler

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  try {
    let body = req.body || {};
    if (typeof body === "string") {
      try { body = JSON.parse(body); } catch { body = {}; }
    }

    const prompt = String(body.prompt || "").trim();
    const webSearch = body.webSearch === true;

    if (!prompt) {
      return res.status(400).json({ ok: false, error: "Prompt is required." });
    }
    if (prompt.length > MAX_PROMPT_CHARS) {
      return res.status(413).json({ ok: false, error: "Prompt is too long." });
    }

    const result = await requestAI({ prompt, webSearch });
    const data = result.data;

    // Live research: use the real sources the search returned. Never keep
    // URLs the model may have made up.
    if (webSearch) {
      data.sources = result.citations;
      if (!result.webSearchUsed) {
        data.note =
          "Live web search was not available for this request, so this summary is based on general knowledge and may not be current. Please verify with official sources.";
      }
    }

    return res.status(200).json({
      ok: true,
      data,
      aiGenerated: true,
      fallbackUsed: false,
      webSearchUsed: result.webSearchUsed,
      model: result.model,
      attempts: result.attempts
    });
  } catch (error) {
    console.error("CareerMitra AI ERROR:", error);

    if (error && error.status === 429) {
      const retryAfter = error.retryAfter || 10;
      res.setHeader("Retry-After", String(retryAfter));
      return res.status(429).json({
        ok: false,
        error: "The AI service is busy right now. Please wait a few seconds and try again.",
        retryAfter
      });
    }

    return res.status(error && error.status === 500 ? 500 : 503).json({
      ok: false,
      error: (error && error.message) || "AI service temporarily unavailable.",
      fallbackAllowed: true
    });
  }
}
