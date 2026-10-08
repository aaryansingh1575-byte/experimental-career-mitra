export const maxDuration = 60;

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

// Free-first reliability chain
const MODELS = [
  "nvidia/nemotron-3-ultra-550b-a55b:free",
  "nvidia/nemotron-3.5-lightning:free",
  "nvidia/nemotron-3-super:free",
  "openrouter/free"
];

function cleanText(v) {
  return String(v ?? "").replace(/\u0000/g, "").trim();
}

function stripFence(text) {
  return String(text || "")
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

function parseJSON(text) {
  if (!text) return null;

  const s = stripFence(text);

  try {
    return JSON.parse(s);
  } catch (_) {}

  const a = s.indexOf("{");
  const b = s.lastIndexOf("}");

  if (a >= 0 && b > a) {
    try {
      return JSON.parse(s.slice(a, b + 1));
    } catch (_) {}
  }

  const x = s.indexOf("[");
  const y = s.lastIndexOf("]");

  if (x >= 0 && y > x) {
    try {
      return JSON.parse(s.slice(x, y + 1));
    } catch (_) {}
  }

  return null;
}

function extractText(data) {
  const c = data?.choices?.[0];

  if (typeof c?.message?.content === "string") {
    return c.message.content.trim();
  }

  if (Array.isArray(c?.message?.content)) {
    return c.message.content
      .map(x =>
        typeof x === "string"
          ? x
          : x?.text || ""
      )
      .join("")
      .trim();
  }

  if (typeof c?.text === "string") {
    return c.text.trim();
  }

  return "";
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function requestModel(model, prompt, webSearch = false) {
  const key = process.env.OPENROUTER_API_KEY;

  if (!key) {
    throw new Error(
      "OPENROUTER_API_KEY is missing in Vercel Environment Variables."
    );
  }

  const controller = new AbortController();

  const timer = setTimeout(
    () => controller.abort(),
    webSearch ? 18000 : 12000
  );

  try {
    const response = await fetch(OPENROUTER_URL, {
      method: "POST",

      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",

        "HTTP-Referer":
          process.env.SITE_URL ||
          "https://careermitra.vercel.app",

        "X-Title": "CareerMitra"
      },

      body: JSON.stringify({
        model,

        messages: [
          {
            role: "system",

            content: webSearch
              ? "You are CareerMitra's careful career research engine. Return valid JSON only when requested."
              : "You are CareerMitra's Test Zone AI. Follow the requested JSON schema exactly. Return valid JSON only."
          },

          {
            role: "user",
            content: prompt
          }
        ],

        temperature: 0.15,

        max_tokens: webSearch
          ? 3200
          : 2200
      }),

      signal: controller.signal
    });

    const raw = await response.text();

    let data = null;

    try {
      data = JSON.parse(raw);
    } catch (_) {}

    if (!response.ok) {
      const error = new Error(
        cleanText(
          data?.error?.message ||
          data?.error ||
          `OpenRouter HTTP ${response.status}`
        )
      );

      error.status = response.status;

      throw error;
    }

    const text = extractText(data);

    if (!text) {
      throw new Error("AI returned an empty response.");
    }

    return text;

  } finally {
    clearTimeout(timer);
  }
}

async function callAI(prompt, webSearch = false) {
  let lastError = null;

  // First model gets two chances.
  // Backup models get one chance each.
  for (let i = 0; i < MODELS.length; i++) {

    const attempts = i === 0 ? 2 : 1;

    for (let attempt = 0; attempt < attempts; attempt++) {

      try {

        const text = await requestModel(
          MODELS[i],
          prompt,
          webSearch
        );

        if (text) {
          return {
            text,
            model: MODELS[i]
          };
        }

      } catch (e) {

        lastError = e;

        console.error(
          "CareerMitra AI attempt failed",
          MODELS[i],
          attempt + 1,
          e?.message
        );

        if (
          [429, 502, 503, 504].includes(e?.status) ||
          e?.name === "AbortError"
        ) {
          await sleep(350);
        }
      }
    }
  }

  throw lastError || new Error("All AI providers failed.");
}

function extractCareer(prompt) {
  const p = cleanText(prompt);

  const patterns = [

    /non[- ]negotiable(?: career)?\s*[:\-]\s*["“']?(.+?)["”']?(?:\n|$)/i,

    /exact career\s*[:\-]\s*["“']?(.+?)["”']?(?:\n|$)/i,

    /career\s+of\s+["“']?(.+?)["”']?(?:\s+in India|\n|$)/i,

    /career\s*[:\-]\s*["“']?(.+?)["”']?(?:\n|$)/i

  ];

  for (const re of patterns) {

    const m = p.match(re);

    if (m?.[1]) {

      return cleanText(m[1])
        .replace(/[.,;]+$/, "");
    }
  }

  return "";
}

function sourcePriority(url) {
  const u = String(url || "").toLowerCase();

  if (
    u.includes(".gov.in") ||
    u.includes(".gov")
  ) {
    return 100;
  }

  if (u.includes("linkedin.com")) {
    return 65;
  }

  if (u.includes("indeed.com")) {
    return 64;
  }

  if (u.includes("glassdoor")) {
    return 60;
  }

  return 40;
}

async function searchWeb(query) {

  try {

    const url =
      "https://www.bing.com/search?format=rss&q=" +
      encodeURIComponent(query);

    const response = await fetch(url, {
      headers: {
        "User-Agent": "CareerMitra/1.0"
      }
    });

    if (!response.ok) {
      return [];
    }

    const xml = await response.text();

    const items =
      xml.match(/<item>[\s\S]*?<\/item>/gi) || [];

    return items
      .slice(0, 6)
      .map(item => {

        const title =
          item.match(
            /<title>([\s\S]*?)<\/title>/i
          )?.[1] || "";

        const link =
          item.match(
            /<link>([\s\S]*?)<\/link>/i
          )?.[1] || "";

        const snippet =
          item.match(
            /<description>([\s\S]*?)<\/description>/i
          )?.[1] || "";

        return {
          title: cleanText(title),
          url: cleanText(link),
          snippet: cleanText(snippet)
        };
      })
      .filter(
        x =>
          x.title &&
          /^https?:\/\//i.test(x.url)
      );

  } catch (_) {

    return [];
  }
}

function researchPrompt(career, evidence) {

  return `
You are CareerMitra's live career research engine.

EXACT CAREER: ${career}

WEB EVIDENCE:
${evidence}

Return ONLY valid JSON with EXACTLY these keys:

{
  "career":"",
  "what_it_involves":"",
  "pros":[],
  "cons":[],
  "pay_india":"",
  "market_requirements":[],
  "demand":"",
  "future_growth":"",
  "step_by_step_path":[],
  "academic_education":[],
  "vocational_diploma":[],
  "certifications":[],
  "job_ready_skills":[],
  "alternatives":[],
  "barriers":[],
  "rewards":[],
  "public_discussion_themes":[],
  "student_fit":"",
  "family_concerns_addressed":"",
  "sources":[]
}

Rules:

1. Keep the exact career name.
2. Use India-focused information.
3. Use web evidence for current claims.
4. Stable career facts may use general professional knowledge.
5. Never invent URLs.
6. Salary information is indicative, not guaranteed.
7. Discuss real market requirements.
8. Discuss demand and future growth.
9. Include academic routes.
10. Include vocational and diploma routes.
11. Include useful certifications.
12. Include job-ready practical skills.
13. Include realistic alternatives.
14. Include barriers and challenges.
15. Include rewards beyond salary.
16. Include common public discussion themes.
17. Explain student fit.
18. Explain family concerns addressed.
19. Return JSON only.
`;
}

function normalizeResearch(
  data,
  career,
  sources
) {

  const d =
    data && typeof data === "object"
      ? { ...data }
      : {};

  d.career = career;

  const aliases = {

    what_it_involves: [
      "role_description",
      "description"
    ],

    pay_india: [
      "earning_reality_india",
      "salary"
    ],

    market_requirements: [
      "requirements",
      "skills"
    ],

    future_growth: [
      "growth_future",
      "future"
    ],

    step_by_step_path: [
      "career_path",
      "path"
    ],

    alternatives: [
      "same_level_alternatives",
      "alternatives"
    ],

    barriers: [
      "struggles_barriers",
      "barriers"
    ],

    rewards: [
      "rewards_beyond_money",
      "rewards"
    ],

    public_discussion_themes: [
      "anecdotal_reviews",
      "public_discussion"
    ]
  };

  for (const [key, list] of Object.entries(aliases)) {

    if (
      d[key] == null ||
      d[key] === ""
    ) {

      for (const alias of list) {

        if (
          d[alias] != null &&
          d[alias] !== ""
        ) {

          d[key] = d[alias];

          break;
        }
      }
    }
  }

  const arrays = [

    "pros",
    "cons",
    "market_requirements",
    "step_by_step_path",
    "academic_education",
    "vocational_diploma",
    "certifications",
    "job_ready_skills",
    "alternatives",
    "barriers",
    "rewards",
    "public_discussion_themes"

  ];

  for (const key of arrays) {

    if (!Array.isArray(d[key])) {

      d[key] = d[key]
        ? [String(d[key])]
        : [];
    }
  }

  if (
    !Array.isArray(d.sources) ||
    !d.sources.length
  ) {

    d.sources = sources;
  }

  if (!d.what_it_involves) {

    d.what_it_involves =
      `The ${career} role involves applying relevant knowledge and practical skills to solve problems and deliver useful outcomes.`;
  }

  if (!d.pay_india) {

    d.pay_india =
      "Pay varies by employer, location, specialization and experience.";
  }

  if (!d.demand) {

    d.demand =
      "Demand varies by specialization, employer and experience level.";
  }

  if (!d.future_growth) {

    d.future_growth =
      "The field continues to evolve, so continuous learning and specialization are important.";
  }

  return d;
}

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
        : (req.body || {});

    const prompt =
      cleanText(body.prompt);

    const webSearch =
      body.webSearch === true;

    if (!prompt) {

      return res.status(400).json({
        ok: false,
        error: "Missing prompt"
      });
    }

    let finalPrompt = prompt;

    let sources = [];

    /*
     * LIVE CAREER RESEARCH
     */

    if (webSearch) {

      const career =
        extractCareer(prompt);

      if (!career) {

        return res.status(400).json({
          ok: false,
          error:
            "Could not determine the exact career."
        });
      }

      const queries = [

        `"${career}" India career`,

        `"${career}" India qualifications education`,

        `"${career}" India salary demand`,

        `"${career}" India future jobs`

      ];

      const groups =
        await Promise.all(
          queries.map(searchWeb)
        );

      const seen = new Set();

      sources =
        groups
          .flat()
          .filter(x => {

            if (
              !x.url ||
              seen.has(x.url)
            ) {
              return false;
            }

            seen.add(x.url);

            return true;
          })
          .sort(
            (a, b) =>
              sourcePriority(b.url) -
              sourcePriority(a.url)
          )
          .slice(0, 12);

      const evidence =
        sources
          .map(
            (x, i) =>
              `[SOURCE ${i + 1}]
${x.title}
${x.url}
${x.snippet}`
          )
          .join("\n\n");

      finalPrompt =
        researchPrompt(
          career,
          evidence ||
            "No usable live source was retrieved."
        );
    }

    /*
     * CALL AI
     */

    let ai =
      await callAI(
        finalPrompt,
        webSearch
      );

    let data =
      parseJSON(ai.text);

    /*
     * JSON REPAIR
     *
     * Only used for live research if
     * the first response isn't valid JSON.
     */

    if (
      webSearch &&
      !data
    ) {

      ai =
        await callAI(
          finalPrompt +
            `

FINAL CHECK:
Return ONLY one valid JSON object.
No markdown.
No commentary.
No explanation.
`,
          true
        );

      data =
        parseJSON(ai.text);
    }

    /*
     * NORMALIZE LIVE RESEARCH
     */

    if (webSearch) {

      data =
        normalizeResearch(
          data,
          extractCareer(prompt),
          sources
        );
    }

    /*
     * SUCCESS
     */

    return res.status(200).json({

      ok: true,

      ai: true,

      fallbackUsed: false,

      data:
        data || ai.text,

      model:
        ai.model,

      sources
    });

  } catch (error) {

    console.error(
      "CareerMitra API ERROR",
      error
    );

    /*
     * IMPORTANT:
     *
     * We do NOT fake AI success here.
     * Frontend can use its built-in fallback
     * when this response is received.
     */

    return res.status(503).json({

      ok: false,

      aiFailed: true,

      fallbackAllowed: true,

      error:
        cleanText(
          error?.message ||
          "AI service temporarily unavailable."
        )
    });
  }
}
