export const maxDuration = 60;

const PRIMARY_MODEL =
  process.env.OPENROUTER_MODEL || "openrouter/free";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

const DEFAULT_SYSTEM = `
You are the AI engine for CareerMitra, an AI-Enabled Career Counselling
and Family Decision Support Platform.

Rules:
1. Return valid JSON whenever JSON is requested.
2. Never invent personal information about the student or family.
3. Use the supplied student/family data as the primary evidence.
4. Do not silently replace the student's non-negotiable career.
5. Distinguish evidence from assumptions.
6. For career recommendations, consider BOTH student evidence and family concerns.
7. Never force a recommendation merely to fill a requested number of results.
8. If evidence is insufficient, explicitly say so.
9. Keep answers practical, specific and suitable for Indian students.
`;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function cleanJsonText(text) {
  if (!text) return "";

  let s = String(text).trim();

  s = s
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  const first = s.search(/[\[{]/);

  if (first > 0) {
    s = s.slice(first);
  }

  const lastObj = s.lastIndexOf("}");
  const lastArr = s.lastIndexOf("]");

  const last = Math.max(lastObj, lastArr);

  if (last >= 0) {
    s = s.slice(0, last + 1);
  }

  return s.trim();
}

function parseJSON(text) {
  const cleaned = cleanJsonText(text);

  try {
    return JSON.parse(cleaned);
  } catch (_) {
    return null;
  }
}

function extractText(data) {
  return (
    data?.choices?.[0]?.message?.content ||
    data?.choices?.[0]?.text ||
    ""
  );
}

function getErrorMessage(data, status) {
  return (
    data?.error?.message ||
    data?.message ||
    `OpenRouter request failed with status ${status}`
  );
}

function isRetryable(status) {
  return [
    408,
    409,
    429,
    500,
    502,
    503,
    504
  ].includes(status);
}

async function callOpenRouter({
  apiKey,
  model,
  prompt,
  temperature = 0.2,
  maxTokens = 5000,
  signal
}) {
  const body = {
    model,
    messages: [
      {
        role: "system",
        content: DEFAULT_SYSTEM
      },
      {
        role: "user",
        content: prompt
      }
    ],
    temperature,
    max_tokens: maxTokens
  };

  const response = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer":
        process.env.APP_URL ||
        process.env.VERCEL_URL ||
        "https://careermitra.vercel.app",
      "X-Title": "CareerMitra"
    },
    body: JSON.stringify(body),
    signal
  });

  let data = {};

  try {
    data = await response.json();
  } catch (_) {
    data = {};
  }

  if (!response.ok) {
    const error = new Error(
      getErrorMessage(data, response.status)
    );

    error.status = response.status;
    error.providerData = data;

    throw error;
  }

  const text = extractText(data);

  if (!text) {
    const error = new Error("AI returned an empty response.");
    error.status = 502;
    throw error;
  }

  return {
    text,
    data
  };
}

/*
 * OpenRouter's free router can choose an available free model.
 *
 * We deliberately do NOT hammer the API with many retries.
 * This is important for rate limits.
 */
async function runAI({
  apiKey,
  prompt,
  temperature,
  maxTokens,
  requireJSON = false
}) {
  const models = [
    PRIMARY_MODEL
  ];

  let lastError = null;

  for (let i = 0; i < models.length; i++) {
    const model = models[i];

    const controller = new AbortController();

    const timeout = setTimeout(() => {
      controller.abort();
    }, 50000);

    try {
      const result = await callOpenRouter({
        apiKey,
        model,
        prompt,
        temperature,
        maxTokens,
        signal: controller.signal
      });

      clearTimeout(timeout);

      if (!requireJSON) {
        return {
          ok: true,
          ai: true,
          model,
          text: result.text
        };
      }

      const parsed = parseJSON(result.text);

      if (!parsed) {
        /*
         * Do not make another expensive AI call just because
         * JSON parsing failed.
         */
        return {
          ok: false,
          ai: true,
          parseFailed: true,
          model,
          raw: result.text
        };
      }

      return {
        ok: true,
        ai: true,
        model,
        data: parsed
      };
    } catch (error) {
      clearTimeout(timeout);

      lastError = error;

      /*
       * One short retry ONLY for transient infrastructure
       * failures. This prevents runaway request consumption.
       */
      if (
        isRetryable(error?.status) &&
        i === models.length - 1
      ) {
        await sleep(350);
      }
    }
  }

  return {
    ok: false,
    ai: false,
    error: lastError?.message || "AI request failed",
    status: lastError?.status || 500
  };
}

/* ---------------------------------------------------------
   LIVE WEB RESEARCH
--------------------------------------------------------- */

async function webSearch(query) {
  try {
    const q = encodeURIComponent(query);

    /*
     * Bing RSS is used only as a lightweight public-source
     * discovery mechanism.
     */
    const url =
      `https://www.bing.com/news/search?q=${q}&format=rss`;

    const response = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 CareerMitra/1.0"
      }
    });

    if (!response.ok) {
      return [];
    }

    const xml = await response.text();

    const items = [];

    const matches = [
      ...xml.matchAll(
        /<item>([\s\S]*?)<\/item>/gi
      )
    ];

    for (const match of matches.slice(0, 8)) {
      const block = match[1];

      const title =
        block.match(/<title>([\s\S]*?)<\/title>/i)?.[1] ||
        "";

      const link =
        block.match(/<link>([\s\S]*?)<\/link>/i)?.[1] ||
        "";

      const pubDate =
        block.match(
          /<pubDate>([\s\S]*?)<\/pubDate>/i
        )?.[1] || "";

      const clean = value =>
        value
          .replace(/<!\[CDATA\[|\]\]>/g, "")
          .replace(/&amp;/g, "&")
          .replace(/&quot;/g, '"')
          .trim();

      if (title && link) {
        items.push({
          title: clean(title),
          url: clean(link),
          date: clean(pubDate)
        });
      }
    }

    return items;
  } catch (_) {
    return [];
  }
}

/* ---------------------------------------------------------
   CAREER RESEARCH NORMALIZATION
--------------------------------------------------------- */

function normalizeResearch(data, career) {
  const d =
    data && typeof data === "object"
      ? data
      : {};

  const arr = value =>
    Array.isArray(value)
      ? value.filter(Boolean)
      : value
      ? [String(value)]
      : [];

  return {
    career:
      d.career ||
      career,

    what_it_involves:
      d.what_it_involves ||
      "Information about the day-to-day work and responsibilities of this career.",

    pros:
      arr(d.pros),

    cons:
      arr(d.cons),

    pay_india:
      d.pay_india ||
      "Salary varies by role, experience, location and employer.",

    market_requirements:
      d.market_requirements ||
      "Requirements vary by employer and specialization.",

    demand:
      d.demand ||
      "Demand depends on the specialization and current market conditions.",

    future_growth:
      d.future_growth ||
      "Future growth depends on technology, industry demand and specialization.",

    step_by_step_path:
      arr(d.step_by_step_path),

    academic_education:
      arr(d.academic_education),

    vocational_diploma:
      arr(d.vocational_diploma),

    certifications:
      arr(d.certifications),

    job_ready_skills:
      arr(d.job_ready_skills),

    alternatives:
      arr(d.alternatives),

    barriers:
      arr(d.barriers),

    rewards:
      arr(d.rewards),

    public_discussion_themes:
      arr(d.public_discussion_themes),

    sources:
      arr(d.sources),

    student_fit:
      d.student_fit || "",

    family_concerns_addressed:
      arr(d.family_concerns_addressed)
  };
}

/* ---------------------------------------------------------
   MAIN HANDLER
--------------------------------------------------------- */

export default async function handler(req, res) {
  /*
   * CORS / basic response headers
   */
  res.setHeader(
    "Cache-Control",
    "no-store"
  );

  if (req.method !== "POST") {
    return res.status(405).json({
      ok: false,
      error: "Method not allowed"
    });
  }

  const apiKey =
    process.env.OPENROUTER_API_KEY;

  if (!apiKey) {
    return res.status(500).json({
      ok: false,
      aiFailed: true,
      fallbackAllowed: true,
      error:
        "OPENROUTER_API_KEY is missing from Vercel environment variables."
    });
  }

  const body =
    req.body && typeof req.body === "object"
      ? req.body
      : {};

  const prompt =
    typeof body.prompt === "string"
      ? body.prompt.trim()
      : "";

  const webSearchRequested =
    Boolean(body.webSearch);

  const temperature =
    typeof body.temperature === "number"
      ? body.temperature
      : 0.2;

  const maxTokens =
    Number(body.maxTokens) > 0
      ? Math.min(Number(body.maxTokens), 10000)
      : 5000;

  const requireJSON =
    body.requireJSON !== false;

  if (!prompt) {
    return res.status(400).json({
      ok: false,
      error: "Prompt is required."
    });
  }

  /*
   * Optional live research.
   *
   * We only perform this when the frontend explicitly
   * requests webSearch.
   */
  let searchResults = [];

  if (webSearchRequested) {
    /*
     * Extract a useful search phrase without making
     * another AI request.
     */
    const careerMatch =
      prompt.match(
        /(?:career|non[- ]negotiable career)\s*[:\-]\s*([^\n]+)/i
      );

    const query =
      careerMatch?.[1]?.trim() ||
      prompt
        .replace(/\s+/g, " ")
        .slice(0, 180);

    searchResults =
      await webSearch(query);
  }

  let finalPrompt = prompt;

  if (searchResults.length) {
    finalPrompt += `

LIVE PUBLIC WEB RESEARCH RESULTS

Use these sources for current claims.
Do not invent source URLs.

${searchResults
  .map(
    (x, i) =>
      `${i + 1}. ${x.title}
URL: ${x.url}
Date: ${x.date}`
  )
  .join("\n\n")}
`;
  }

  /*
   * Explicit instruction for structured outputs.
   */
  if (requireJSON) {
    finalPrompt += `

OUTPUT REQUIREMENT

Return ONLY valid JSON.
Do not use markdown.
Do not wrap the JSON in \`\`\`.
Do not add explanations before or after the JSON.
`;
  }

  const result = await runAI({
    apiKey,
    prompt: finalPrompt,
    temperature,
    maxTokens,
    requireJSON
  });

  /*
   * SUCCESS
   */
  if (result.ok) {
    return res.status(200).json({
      ok: true,
      ai: true,
      fallbackUsed: false,
      model: result.model,
      data: requireJSON
        ? result.data
        : result.text,
      sources:
        searchResults.length
          ? searchResults
          : undefined
    });
  }

  /*
   * AI failed.
   *
   * IMPORTANT:
   * We do not keep retrying here.
   *
   * The frontend can immediately activate its
   * built-in fallback generator.
   */
  return res.status(503).json({
    ok: false,
    ai: false,
    aiFailed: true,
    fallbackAllowed: true,
    status: result.status || 503,
    error:
      result.error ||
      "AI service temporarily unavailable.",
    sources:
      searchResults.length
        ? searchResults
        : undefined
  });
}
