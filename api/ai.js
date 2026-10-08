export const maxDuration = 10;

const MODEL =
  process.env.OPENROUTER_MODEL ||
  "nvidia/nemotron-3-ultra-550b-a55b:free";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

function cleanText(value) {
  return String(value ?? "")
    .replace(/\u0000/g, "")
    .trim();
}

function extractCareer(prompt = "") {
  const p = cleanText(prompt);

  const patterns = [
    /non[- ]negotiable career\s*[:\-]\s*(.+?)(?:\n|$)/i,
    /exact career\s*[:\-]\s*(.+?)(?:\n|$)/i,
    /career of\s*[:\-]\s*(.+?)(?:\n|$)/i,
    /research this career\s*[:\-]\s*(.+?)(?:\n|$)/i,
    /career\s*[:\-]\s*(.+?)(?:\n|$)/i
  ];

  for (const re of patterns) {
    const m = p.match(re);
    if (m && m[1]) return cleanText(m[1]);
  }

  return "";
}

function extractModelText(data) {
  if (!data) return "";

  const choice = data?.choices?.[0];

  if (typeof choice?.message?.content === "string") {
    return choice.message.content.trim();
  }

  if (Array.isArray(choice?.message?.content)) {
    return choice.message.content
      .map(x => typeof x === "string" ? x : x?.text || "")
      .join("")
      .trim();
  }

  if (typeof choice?.text === "string") {
    return choice.text.trim();
  }

  return "";
}

function stripCodeFence(text) {
  return String(text || "")
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

function parseJSON(text) {
  if (!text) return null;

  const cleaned = stripCodeFence(text);

  try {
    return JSON.parse(cleaned);
  } catch (_) {}

  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");

  if (start >= 0 && end > start) {
    try {
      return JSON.parse(cleaned.slice(start, end + 1));
    } catch (_) {}
  }

  return null;
}

async function callAI(messages) {
  const key = process.env.OPENROUTER_API_KEY;

  if (!key) {
    throw new Error("OPENROUTER_API_KEY is not configured.");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 9000);

  try {
    const response = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${key}`,
        "Content-Type": "application/json",
        "HTTP-Referer":
          process.env.SITE_URL || "https://careermitra.vercel.app",
        "X-Title": "CareerMitra"
      },
      body: JSON.stringify({
        model: MODEL,
        messages,
        temperature: 0.35,
        max_tokens: 3500
      }),
      signal: controller.signal
    });

    const text = await response.text();

    let data = null;

    try {
      data = JSON.parse(text);
    } catch (_) {
      data = null;
    }

    if (!response.ok) {
      const msg =
        data?.error?.message ||
        data?.error ||
        `OpenRouter returned HTTP ${response.status}`;

      throw new Error(cleanText(msg));
    }

    const output = extractModelText(data);

    if (!output) {
      throw new Error("AI returned an empty response.");
    }

    return output;
  } finally {
    clearTimeout(timeout);
  }
}

/* ================= WEB SEARCH ================= */

async function searchWeb(query) {
  const q = encodeURIComponent(query);

  const urls = [
    `https://www.google.com/search?q=${q}`,
    `https://www.bing.com/search?q=${q}`
  ];

  const results = [];

  for (const url of urls) {
    try {
      const r = await fetch(url, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/154 Safari/537.36"
        }
      });

      if (!r.ok) continue;

      const html = await r.text();

      const clean = html
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();

      if (clean.length > 300) {
        results.push({
          query,
          text: clean.slice(0, 7000)
        });
      }

      if (results.length >= 2) break;
    } catch (_) {
      // Search is supplementary. AI can still answer using general knowledge.
    }
  }

  return results;
}

function uniqueSources(items) {
  const seen = new Set();
  const out = [];

  for (const item of items || []) {
    const url = cleanText(item?.url);

    if (!url || seen.has(url)) continue;

    seen.add(url);

    out.push({
      title: cleanText(item?.title) || "Public web source",
      url
    });
  }

  return out;
}

/* ================= CAREER RESEARCH ================= */

function researchPrompt(career, webData) {
  return `
You are the career research engine inside CareerMitra.

Research the EXACT career requested below.

CAREER:
${career}

CURRENT PUBLIC WEB MATERIAL:
${JSON.stringify(webData).slice(0, 30000)}

Return ONLY valid JSON.

Use exactly these keys:

{
  "career": "",
  "what_it_involves": "",
  "pros": [],
  "cons": [],
  "pay_india": "",
  "market_requirements": [],
  "demand": "",
  "future_growth": "",
  "step_by_step_path": [],
  "academic_education": [],
  "vocational_diploma": [],
  "certifications": [],
  "job_ready_skills": [],
  "alternatives": [],
  "barriers": [],
  "rewards": [],
  "public_discussion_themes": [],
  "student_fit": "",
  "family_concerns_addressed": "",
  "sources": []
}

Rules:

1. Keep the career EXACTLY as requested.
2. Do not replace it with another career.
3. Give practical India-focused information.
4. Do not leave sections blank when stable professional knowledge can answer them.
5. Use web material for current claims such as market demand, salary and future trends.
6. Stable/basic career descriptions may use general professional knowledge.
7. Never invent URLs.
8. If salary varies heavily, clearly say it is indicative.
9. Public discussion themes are anecdotal/community observations, not scientific facts.
10. Academic education must explain the degree/education route.
11. Vocational/diploma must explain non-degree routes where relevant.
12. Certifications should be useful, not random.
13. Job-ready skills should be concrete.
14. Keep the response concise but useful.
15. Do not return markdown.
16. Return JSON only.
`;
}

/* ================= HANDLER ================= */

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      ok: false,
      error: "Method not allowed"
    });
  }

  try {
    const body =
      typeof req.body === "string"
        ? JSON.parse(req.body || "{}")
        : req.body || {};

    const prompt = cleanText(body.prompt);
    const webSearch = body.webSearch === true;

    if (!prompt) {
      return res.status(400).json({
        ok: false,
        error: "Missing prompt"
      });
    }

    /* ================= LIVE CAREER RESEARCH ================= */

    if (webSearch) {
      const career = extractCareer(prompt);

      if (!career) {
        return res.status(400).json({
          ok: false,
          error: "Could not determine the exact career to research."
        });
      }

      const queries = [
        `"${career}" India career`,
        `"${career}" India job responsibilities`,
        `"${career}" India qualifications education`,
        `"${career}" India salary`,
        `"${career}" India demand jobs`,
        `"${career}" India future scope`,
        `"${career}" India career path`
      ];

      const searchResults = [];

      for (const query of queries) {
        const found = await searchWeb(query);

        for (const item of found) {
          searchResults.push(item);
        }

        if (searchResults.length >= 10) break;
      }

      const research = await callAI([
        {
          role: "system",
          content:
            "You are a careful career research assistant. Return only valid JSON."
        },
        {
          role: "user",
          content: researchPrompt(career, searchResults)
        }
      ]);

      const parsed = parseJSON(research);

      if (!parsed || typeof parsed !== "object") {
        throw new Error("AI returned invalid career research JSON.");
      }

      parsed.career = career;

      if (!Array.isArray(parsed.pros)) parsed.pros = [];
      if (!Array.isArray(parsed.cons)) parsed.cons = [];
      if (!Array.isArray(parsed.market_requirements))
        parsed.market_requirements = [];
      if (!Array.isArray(parsed.step_by_step_path))
        parsed.step_by_step_path = [];
      if (!Array.isArray(parsed.academic_education))
        parsed.academic_education = [];
      if (!Array.isArray(parsed.vocational_diploma))
        parsed.vocational_diploma = [];
      if (!Array.isArray(parsed.certifications))
        parsed.certifications = [];
      if (!Array.isArray(parsed.job_ready_skills))
        parsed.job_ready_skills = [];
      if (!Array.isArray(parsed.alternatives))
        parsed.alternatives = [];
      if (!Array.isArray(parsed.barriers))
        parsed.barriers = [];
      if (!Array.isArray(parsed.rewards))
        parsed.rewards = [];
      if (!Array.isArray(parsed.public_discussion_themes))
        parsed.public_discussion_themes = [];

      parsed.sources = uniqueSources(
        Array.isArray(parsed.sources) ? parsed.sources : []
      );

      return res.status(200).json({
        ok: true,
        ai: true,
        fallbackUsed: false,
        data: parsed,
        sources: parsed.sources
      });
    }

    /* ================= NORMAL AI ================= */

    const output = await callAI([
      {
        role: "system",
        content:
          "You are CareerMitra's AI engine. Follow the user's requested JSON format exactly when one is provided."
      },
      {
        role: "user",
        content: prompt
      }
    ]);

    const parsed = parseJSON(output);

    return res.status(200).json({
      ok: true,
      ai: true,
      fallbackUsed: false,
      data: parsed || output
    });

  } catch (error) {
    console.error("CareerMitra AI error:", error);

    /*
      IMPORTANT:
      Do NOT run the built-in generator here.

      The frontend handles fallback so it can correctly show:
      🟢 = AI only
      🟠 = built-in fallback used
    */

    return res.status(503).json({
      ok: false,
      aiFailed: true,
      fallbackAllowed: true,
      error: cleanText(error?.message || "AI service failed.")
    });
  }
}
