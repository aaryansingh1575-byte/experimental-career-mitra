// api/ai.js
// CareerMitra — AI endpoint
// AI is the primary generator.
// The frontend has its own built-in fallback so the MVP never depends
// completely on the availability of the AI API.

export const maxDuration = 10;

const MODEL =
  process.env.OPENROUTER_MODEL ||
  "nvidia/nemotron-3-ultra-550b-a55b:free";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

function cleanText(value, max = 12000) {
  return String(value ?? "")
    .replace(/\u0000/g, "")
    .trim()
    .slice(0, max);
}

function extractCareer(prompt) {
  const p = cleanText(prompt, 20000);

  const patterns = [
    /non[- ]negotiable career\s*[:\-]\s*["“]?([^"”\n]+)["”]?/i,
    /exact career\s*[:\-]\s*["“]?([^"”\n]+)["”]?/i,
    /career\s*[:\-]\s*["“]?([^"”\n]+)["”]?/i,
    /role\s*[:\-]\s*["“]?([^"”\n]+)["”]?/i,
    /career of\s*["“]?([^"”\n]+)["”]?/i
  ];

  for (const re of patterns) {
    const m = p.match(re);
    if (m && m[1]) return cleanText(m[1], 300);
  }

  return "";
}

function isBadResult(value) {
  if (!value) return true;

  if (typeof value === "string") {
    const x = value.trim().toLowerCase();

    return (
      !x ||
      x === "null" ||
      x === "undefined" ||
      x.includes("i cannot") ||
      x.includes("i can't") ||
      x.includes("unable to generate")
    );
  }

  if (typeof value === "object") {
    return Object.keys(value).length === 0;
  }

  return false;
}

function sourcePriority(url) {
  const u = String(url || "").toLowerCase();

  if (
    u.includes(".gov.in") ||
    u.includes("gov.in") ||
    u.includes("ncs.gov.in")
  ) {
    return 100;
  }

  if (
    u.includes("ugc.gov.in") ||
    u.includes("aicte-india.org") ||
    u.includes("niti.gov.in")
  ) {
    return 95;
  }

  if (
    u.includes("linkedin.com") ||
    u.includes("indeed.com") ||
    u.includes("glassdoor.co.in")
  ) {
    return 85;
  }

  if (
    u.includes("coursera.org") ||
    u.includes("edx.org") ||
    u.includes("upgrad.com")
  ) {
    return 70;
  }

  return 50;
}

function extractModelText(data) {
  try {
    const content = data?.choices?.[0]?.message?.content;

    if (typeof content === "string") {
      return content.trim();
    }

    if (Array.isArray(content)) {
      return content
        .map(x => {
          if (typeof x === "string") return x;
          return x?.text || "";
        })
        .join("")
        .trim();
    }

    return "";
  } catch {
    return "";
  }
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

  let cleaned = stripCodeFence(text);

  try {
    return JSON.parse(cleaned);
  } catch {}

  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");

  if (start >= 0 && end > start) {
    try {
      return JSON.parse(cleaned.slice(start, end + 1));
    } catch {}
  }

  const arrStart = cleaned.indexOf("[");
  const arrEnd = cleaned.lastIndexOf("]");

  if (arrStart >= 0 && arrEnd > arrStart) {
    try {
      return JSON.parse(cleaned.slice(arrStart, arrEnd + 1));
    } catch {}
  }

  return null;
}

async function callAI(prompt) {
  const key = process.env.OPENROUTER_API_KEY;

  if (!key) {
    throw new Error("OPENROUTER_API_KEY is not configured");
  }

  const response = await fetch(OPENROUTER_URL, {
    method: "POST",

    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,

      "HTTP-Referer":
        process.env.APP_URL ||
        "https://careermitra.vercel.app",

      "X-Title": "CareerMitra"
    },

    body: JSON.stringify({
      model: MODEL,

      messages: [
        {
          role: "system",
          content:
            "You are CareerMitra, an AI career guidance assistant. " +
            "Use the student's Personal Vault when provided. " +
            "Return exactly the requested format. " +
            "Use simple English. Do not invent sources or URLs."
        },

        {
          role: "user",
          content: cleanText(prompt, 30000)
        }
      ],

      temperature: 0.35,

      max_tokens: 5000
    }),

    signal: AbortSignal.timeout(9000)
  });

  const raw = await response.text();

  let data = null;

  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(
      `AI returned invalid response (${response.status})`
    );
  }

  if (!response.ok) {
    const msg =
      data?.error?.message ||
      data?.message ||
      `OpenRouter error ${response.status}`;

    throw new Error(msg);
  }

  const text = extractModelText(data);

  if (!text) {
    throw new Error("AI returned an empty response");
  }

  return text;
}


/* =========================================================
   LIVE WEB SEARCH
   ========================================================= */

async function searchWeb(query) {
  const q = cleanText(query, 300);

  if (!q) return [];

  try {
    const url =
      "https://www.bing.com/search?format=rss&q=" +
      encodeURIComponent(q);

    const response = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 CareerMitra/1.0"
      },

      signal: AbortSignal.timeout(6000)
    });

    if (!response.ok) return [];

    const xml = await response.text();

    const items = [];

    const matches = xml.matchAll(
      /<item>([\s\S]*?)<\/item>/gi
    );

    for (const match of matches) {
      const block = match[1];

      const title =
        block
          .match(/<title>([\s\S]*?)<\/title>/i)?.[1]
          ?.replace(/<!\[CDATA\[|\]\]>/g, "")
          ?.trim() || "";

      const link =
        block
          .match(/<link>([\s\S]*?)<\/link>/i)?.[1]
          ?.trim() || "";

      const description =
        block
          .match(
            /<description>([\s\S]*?)<\/description>/i
          )?.[1]
          ?.replace(/<!\[CDATA\[|\]\]>/g, "")
          ?.replace(/<[^>]+>/g, " ")
          ?.trim() || "";

      if (title && link) {
        items.push({
          title: cleanText(title, 300),
          url: link,
          snippet: cleanText(description, 700),
          priority: sourcePriority(link)
        });
      }
    }

    return items;
  } catch (error) {
    console.warn("CareerMitra web search failed:", error);
    return [];
  }
}


/* =========================================================
   SOURCE DEDUPLICATION
   ========================================================= */

function uniqueSources(items) {
  const seen = new Set();

  return items
    .filter(item => {
      const key = String(item.url || "")
        .toLowerCase()
        .replace(/\/$/, "");

      if (!key || seen.has(key)) return false;

      seen.add(key);
      return true;
    })
    .sort((a, b) => {
      return (
        (b.priority || 0) -
        (a.priority || 0)
      );
    })
    .slice(0, 15)
    .map(x => ({
      title: x.title,
      url: x.url,
      snippet: x.snippet
    }));
}


/* =========================================================
   CAREER RESEARCH PROMPT
   ========================================================= */

function researchPrompt(career, sources) {
  return `
You are researching the EXACT career requested by a student.

CAREER:
${career}

Use the retrieved public web sources below for current claims.

IMPORTANT:
- Do not silently replace the career with a broader or different career.
- Give useful information even if the web sources are incomplete.
- Stable/basic career descriptions may use general professional knowledge.
- Current claims such as salary, demand and market trends should use retrieved sources where possible.
- Never invent a URL.
- Never leave a section blank.
- Do not write "unavailable" when a reasonable general answer can be given.
- Use simple English.
- Keep the answer practical for an Indian student.

Return ONLY valid JSON.

Required structure:

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
  "family_concerns_addressed": [],
  "sources": []
}

WEB SOURCES:

${JSON.stringify(sources, null, 2)}
`;
}


/* =========================================================
   MAIN HANDLER
   ========================================================= */

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
        ? JSON.parse(req.body)
        : req.body || {};

    const prompt = cleanText(body.prompt, 30000);

    const webSearch =
      body.webSearch === true;

    if (!prompt) {
      return res.status(400).json({
        ok: false,
        error: "Missing prompt"
      });
    }


    /* =====================================================
       LIVE CAREER RESEARCH
       ===================================================== */

    if (webSearch) {
      const career =
        extractCareer(prompt) ||
        "the requested career";

      const queries = [
        `"${career}" India career`,
        `"${career}" India jobs`,
        `"${career}" responsibilities qualifications`,
        `"${career}" India salary`,
        `"${career}" India demand`,
        `"${career}" future growth`,
        `"${career}" education degree`,
        `"${career}" career path`,
        `"${career}" skills requirements`
      ];

      const allResults = [];

      for (const query of queries) {
        const results =
          await searchWeb(query);

        allResults.push(...results);
      }

      const sources =
        uniqueSources(allResults);

      const finalPrompt =
        researchPrompt(
          career,
          sources
        );

      let text;

      try {
        text =
          await callAI(finalPrompt);
      } catch (error) {
        console.error(
          "Career research AI failed:",
          error
        );

        /*
         * IMPORTANT:
         * We intentionally return an AI failure.
         * The frontend can then use its local fallback.
         * This keeps the MVP alive.
         */
        return res.status(503).json({
          ok: false,
          aiFailed: true,
          fallbackAllowed: true,
          error:
            "AI research service temporarily unavailable",
          sources
        });
      }

      const parsed =
        parseJSON(text);

      if (!parsed || typeof parsed !== "object") {
        return res.status(502).json({
          ok: false,
          aiFailed: true,
          fallbackAllowed: true,
          error:
            "AI returned an invalid research response",
          sources
        });
      }

      /*
       * Make sure the frontend always receives the
       * expected source array.
       */

      if (
        !Array.isArray(parsed.sources) ||
        !parsed.sources.length
      ) {
        parsed.sources =
          sources.map(x => ({
            title: x.title,
            url: x.url,
            snippet: x.snippet
          }));
      }

      return res.status(200).json({
        ok: true,
        ai: true,
        fallbackUsed: false,
        data: parsed,
        sources
      });
    }


    /* =====================================================
       NORMAL AI REQUEST
       ===================================================== */

    let text;

    try {
      text =
        await callAI(prompt);
    } catch (error) {
      console.error(
        "CareerMitra AI failed:",
        error
      );

      return res.status(503).json({
        ok: false,

        /*
         * Frontend checks this and switches to
         * its built-in generator.
         */
        aiFailed: true,
        fallbackAllowed: true,

        error:
          "AI service temporarily unavailable"
      });
    }


    /*
     * Most CareerMitra Test Zone calls expect JSON.
     * Parse it when possible, otherwise return the raw
     * AI text.
     */

    const parsed =
      parseJSON(text);

    if (parsed !== null) {
      return res.status(200).json({
        ok: true,
        ai: true,
        fallbackUsed: false,
        data: parsed
      });
    }

    /*
     * Raw text is still a valid AI result for prompts
     * that don't require JSON.
     */

    return res.status(200).json({
      ok: true,
      ai: true,
      fallbackUsed: false,
      data: text
    });

  } catch (error) {
    console.error(
      "CareerMitra /api/ai error:",
      error
    );

    return res.status(500).json({
      ok: false,
      aiFailed: true,
      fallbackAllowed: true,
      error:
        error?.message ||
        "Unexpected AI server error"
    });
  }
}
