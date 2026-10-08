export const maxDuration = 60;

const OPENROUTER_URL =
  "https://openrouter.ai/api/v1/chat/completions";

// Keep the router configurable.
// Default = OpenRouter's free router.
const PRIMARY_MODEL =
  process.env.OPENROUTER_MODEL || "openrouter/free";

const FALLBACK_MODELS = [
  PRIMARY_MODEL,
  "nvidia/nemotron-3-ultra:free",
  "nvidia/nemotron-3-super-120b-a12b:free",
  "nvidia/nemotron-3.5-lightning:free"
].filter(
  (v, i, a) => v && a.indexOf(v) === i
);


/* =========================================================
   BASIC HELPERS
========================================================= */

function cleanText(v) {
  return String(v ?? "")
    .replace(/\u0000/g, "")
    .trim();
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
      return JSON.parse(
        s.slice(a, b + 1)
      );
    } catch (_) {}
  }

  const x = s.indexOf("[");
  const y = s.lastIndexOf("]");

  if (x >= 0 && y > x) {
    try {
      return JSON.parse(
        s.slice(x, y + 1)
      );
    } catch (_) {}
  }

  return null;
}


function extractText(data) {
  const c = data?.choices?.[0];

  if (
    typeof c?.message?.content ===
    "string"
  ) {
    return c.message.content.trim();
  }

  if (
    Array.isArray(
      c?.message?.content
    )
  ) {
    return c.message.content
      .map(x =>
        typeof x === "string"
          ? x
          : x?.text || ""
      )
      .join("")
      .trim();
  }

  if (
    typeof c?.text === "string"
  ) {
    return c.text.trim();
  }

  return "";
}


/* =========================================================
   PURPOSE DETECTION
========================================================= */

function purposeFor(
  prompt,
  webSearch
) {
  const p =
    String(prompt || "")
      .toLowerCase();

  if (webSearch) {
    return "live career research";
  }

  if (
    /common ground|both sides|family concerns|student test analysis|decision-support analyst/
      .test(p)
  ) {
    return "common-ground analysis";
  }

  if (
    /parent|family|sincere|specific|relevant response|concern/
      .test(p)
  ) {
    return "family question/answer analysis";
  }

  if (
    /complete test|question plan|holland|personal vault|multiple-choice questions/
      .test(p)
  ) {
    return "student test generation";
  }

  if (
    /personality-and-interest test|holland-code tallies|career counsellor/
      .test(p)
  ) {
    return "student test answer analysis";
  }

  return "career counselling";
}


/* =========================================================
   OPENROUTER REQUEST
========================================================= */

async function requestAI(
  prompt,
  webSearch = false
) {
  const key =
    process.env.OPENROUTER_API_KEY;

  if (!key) {
    throw new Error(
      "OPENROUTER_API_KEY is missing in Vercel Environment Variables."
    );
  }

  const controller =
    new AbortController();

  const timer = setTimeout(
    () => controller.abort(),
    webSearch
      ? 55000
      : 40000
  );

  const purpose =
    purposeFor(
      prompt,
      webSearch
    );

  const system = `
You are CareerMitra's ${purpose} engine.

Return ONLY the JSON requested by the user.

Do not add:
- markdown fences
- commentary
- disclaimers
- invented evidence

For analysis tasks:
- use supplied student/family data strictly
- do not invent personal information
- do not silently replace the student's non-negotiable career
- do not manufacture family concerns
- do not manufacture student preferences

For live research:
- keep the exact career
- use supplied web evidence for current claims
- never invent URLs
- never invent salaries
- never invent qualifications
- never invent market statistics

If evidence is insufficient:
say that it is insufficient instead of guessing.
`;

  try {
    const response =
      await fetch(
        OPENROUTER_URL,
        {
          method: "POST",

          headers: {
            Authorization:
              `Bearer ${key}`,

            "Content-Type":
              "application/json",

            "HTTP-Referer":
              process.env.SITE_URL ||
              "https://careermitra.vercel.app",

            "X-Title":
              "CareerMitra"
          },

          body: JSON.stringify({
            model:
              PRIMARY_MODEL,

            /*
             * OpenRouter model-level
             * fallback.
             *
             * This is intentionally used
             * instead of repeatedly sending
             * the same request ourselves.
             */
            models:
              FALLBACK_MODELS,

            messages: [
              {
                role: "system",
                content: system
              },
              {
                role: "user",
                content: prompt
              }
            ],

            temperature:
              webSearch
                ? 0.1
                : 0.2,

            max_tokens:
              webSearch
                ? 5000
                : 6000,

            provider: {
              allow_fallbacks:
                true,

              sort:
                "throughput"
            }
          }),

          signal:
            controller.signal
        }
      );

    const raw =
      await response.text();

    let data = null;

    try {
      data =
        JSON.parse(raw);
    } catch (_) {}

    if (!response.ok) {
      const error =
        new Error(
          cleanText(
            data?.error?.message ||
            data?.error ||
            `OpenRouter HTTP ${response.status}`
          )
        );

      error.status =
        response.status;

      error.retryAfter =
        response.headers.get(
          "retry-after"
        ) || null;

      throw error;
    }

    const text =
      extractText(data);

    if (!text) {
      throw new Error(
        "OpenRouter returned an empty AI response."
      );
    }

    return {
      text,
      model:
        data?.model ||
        PRIMARY_MODEL
    };
  } finally {
    clearTimeout(timer);
  }
}


/* =========================================================
   EXACT CAREER EXTRACTION
========================================================= */

function extractCareer(
  prompt,
  suppliedCareer = ""
) {
  if (
    cleanText(
      suppliedCareer
    )
  ) {
    return cleanText(
      suppliedCareer
    );
  }

  const p =
    cleanText(prompt);

  const patterns = [
    /EXACT CAREER\s*:\s*["“']?(.+?)["”']?(?:\n|$)/i,

    /non[- ]negotiable(?: career)?\s*[:\-]\s*["“']?(.+?)["”']?(?:\n|$)/i,

    /exact career\s*[:\-]\s*["“']?(.+?)["”']?(?:\n|$)/i,

    /career\s+of\s+["“']?(.+?)["”']?(?:\s+in India|\n|$)/i,

    /career\s*[:\-]\s*["“']?(.+?)["”']?(?:\n|$)/i
  ];

  for (const re of patterns) {
    const m =
      p.match(re);

    if (m?.[1]) {
      return cleanText(
        m[1]
      ).replace(
        /[.,;]+$/,
        ""
      );
    }
  }

  return "";
}


/* =========================================================
   SOURCE PRIORITY
========================================================= */

function sourcePriority(
  url
) {
  const u =
    String(url || "")
      .toLowerCase();

  if (
    u.includes(".gov.in") ||
    u.includes(".gov")
  ) {
    return 100;
  }

  if (
    u.includes("ac.in") ||
    u.includes("edu")
  ) {
    return 90;
  }

  if (
    u.includes("who.int")
  ) {
    return 90;
  }

  if (
    u.includes("ncs.gov.in")
  ) {
    return 95;
  }

  if (
    u.includes("linkedin.com")
  ) {
    return 65;
  }

  if (
    u.includes("indeed.com")
  ) {
    return 64;
  }

  if (
    u.includes("glassdoor")
  ) {
    return 60;
  }

  return 40;
}


/* =========================================================
   WEB SEARCH
========================================================= */

async function searchWeb(
  query
) {
  try {
    const url =
      "https://www.bing.com/search?format=rss&q=" +
      encodeURIComponent(query);

    const r =
      await fetch(
        url,
        {
          headers: {
            "User-Agent":
              "CareerMitra/1.0"
          }
        }
      );

    if (!r.ok) {
      return [];
    }

    const xml =
      await r.text();

    const items =
      xml.match(
        /<item>[\s\S]*?<\/item>/gi
      ) || [];

    return items
      .slice(0, 8)
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
          title:
            cleanText(title),

          url:
            cleanText(link),

          snippet:
            cleanText(snippet)
        };
      })
      .filter(
        x =>
          x.title &&
          /^https?:\/\//i.test(
            x.url
          )
      );
  } catch (_) {
    return [];
  }
}


/* =========================================================
   LIVE RESEARCH PROMPT
========================================================= */

function researchPrompt(
  career,
  evidence
) {
  return `
You are CareerMitra's live career research engine
for an Indian student.

EXACT CAREER:
${career}

COUNTRY:
India

CURRENT WEB EVIDENCE:
${evidence ||
"No usable live source was retrieved."}

Return ONLY valid JSON with exactly these keys:

{
  "career":"exact researched career name",

  "what_it_involves":
  "what the role actually does",

  "pros":[],

  "cons":[],

  "pay_india":
  "realistic current India earning/pay picture with context",

  "market_requirements":[],

  "demand":
  "current demand with evidence/context",

  "future_growth":
  "growth, changes, opportunities and uncertainties",

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

  "family_concerns_addressed":[],

  "sources":[]
}

RULES:

1. Keep the exact career.

2. Do NOT replace it with:
   - a broader career
   - a similar career
   - an alternative career

3. Use India-focused information.

4. Use current web evidence for:
   - salary
   - demand
   - market conditions
   - current requirements
   - current trends

5. Stable role and education facts may use
   professional knowledge when necessary.

6. Never invent URLs.

7. Salary is indicative, not guaranteed.

8. Public discussion themes are anecdotal.
   Do NOT present them as survey statistics.

9. If something cannot be verified,
   say that it cannot be verified.

10. Return JSON only.
`;
}


/* =========================================================
   NORMALIZE RESEARCH
========================================================= */

function normalizeResearch(
  data,
  career,
  sources
) {
  const d =
    data &&
    typeof data === "object"
      ? { ...data }
      : {};

  d.career =
    career;

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
      "same_level_alternatives"
    ],

    barriers: [
      "struggles_barriers"
    ],

    rewards: [
      "rewards_beyond_money"
    ],

    public_discussion_themes: [
      "anecdotal_reviews",
      "public_discussion"
    ],

    family_concerns_addressed: [
      "family_concerns"
    ]
  };

  for (
    const [key, list]
    of Object.entries(
      aliases
    )
  ) {
    if (
      d[key] == null ||
      d[key] === ""
    ) {
      for (
        const a of list
      ) {
        if (
          d[a] != null &&
          d[a] !== ""
        ) {
          d[key] =
            d[a];

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
    "public_discussion_themes",
    "family_concerns_addressed",
    "sources"
  ];

  for (
    const k of arrays
  ) {
    if (
      !Array.isArray(
        d[k]
      )
    ) {
      d[k] =
        d[k]
          ? [String(d[k])]
          : [];
    }
  }

  if (
    !d.sources.length
  ) {
    d.sources =
      sources;
  }

  if (
    !d.what_it_involves
  ) {
    d.what_it_involves =
      `The ${career} role involves applying relevant knowledge and practical skills to solve problems and deliver useful outcomes.`;
  }

  if (
    !d.pay_india
  ) {
    d.pay_india =
      "Current India salary could not be reliably verified from the retrieved sources.";
  }

  if (
    !d.demand
  ) {
    d.demand =
      "Current demand could not be reliably verified from the retrieved sources.";
  }

  if (
    !d.future_growth
  ) {
    d.future_growth =
      "Future growth could not be reliably verified from the retrieved sources.";
  }

  return d;
}


/* =========================================================
   LIVE RESEARCH FALLBACK
========================================================= */

function webFallbackResearch(
  career,
  sources
) {
  const sourceLines =
    sources
      .slice(0, 8)
      .map(
        x =>
          `${x.title}${
            x.snippet
              ? ` — ${x.snippet}`
              : ""
          }`
      );

  return normalizeResearch(
    {
      career,

      what_it_involves:
        `Live AI analysis was temporarily unavailable, but current public web results were retrieved for the exact career "${career}". Review the sources below for the current role context.`,

      pros: [
        "Career-specific opportunities should be evaluated from the current sources below."
      ],

      cons: [
        "Exact current trade-offs could not be safely synthesized because the AI analysis service was unavailable."
      ],

      pay_india:
        "AI synthesis unavailable. Do not treat an unsynthesized salary figure as verified.",

      market_requirements:
        sourceLines,

      demand:
        sourceLines.length
          ? `Current web results were retrieved for ${career}; AI synthesis is temporarily unavailable.`
          : "No current web results were retrieved.",

      future_growth:
        "AI synthesis unavailable; current source results are shown below.",

      step_by_step_path: [],

      academic_education: [],

      vocational_diploma: [],

      certifications: [],

      job_ready_skills: [],

      alternatives: [],

      barriers: [],

      rewards: [],

      public_discussion_themes: [],

      student_fit: "",

      family_concerns_addressed: [],

      sources
    },

    career,
    sources
  );
}


/* =========================================================
   MAIN VERCEL HANDLER
========================================================= */

export default async function handler(
  req,
  res
) {
  if (
    req.method !== "POST"
  ) {
    return res.status(405).json({
      ok: false,
      error:
        "Method not allowed"
    });
  }

  try {
    const body =
      typeof req.body ===
      "string"
        ? JSON.parse(
            req.body || "{}"
          )
        : (
            req.body || {}
          );

    const prompt =
      cleanText(
        body.prompt
      );

    const webSearch =
      body.webSearch === true;

    const suppliedCareer =
      cleanText(
        body.career
      );

    if (!prompt) {
      return res.status(400).json({
        ok: false,
        error:
          "Missing prompt"
      });
    }

    let finalPrompt =
      prompt;

    let sources = [];

    let career =
      suppliedCareer ||
      extractCareer(
        prompt
      );


    /* =====================================================
       LIVE WEB RESEARCH
    ===================================================== */

    if (webSearch) {
      if (!career) {
        return res.status(400).json({
          ok: false,
          error:
            "Could not determine the exact career."
        });
      }

      /*
       * Multiple focused searches.
       *
       * This is much better than asking one search
       * to answer everything.
       */

      const queries = [
        `"${career}" India career qualifications education`,

        `"${career}" India salary demand jobs`,

        `"${career}" India future growth market`,

        `"${career}" India government professional requirements`
      ];

      const groups =
        await Promise.all(
          queries.map(
            searchWeb
          )
        );

      const seen =
        new Set();

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

            seen.add(
              x.url
            );

            return true;
          })
          .sort(
            (a, b) =>
              sourcePriority(
                b.url
              ) -
              sourcePriority(
                a.url
              )
          )
          .slice(0, 16);

      const evidence =
        sources
          .map(
            (x, i) =>
              `[SOURCE ${i + 1}]
TITLE: ${x.title}
URL: ${x.url}
SNIPPET: ${x.snippet}`
          )
          .join(
            "\n\n"
          );

      finalPrompt =
        researchPrompt(
          career,
          evidence
        );
    }


    /* =====================================================
       CALL AI
    ===================================================== */

    let ai;

    try {
      ai =
        await requestAI(
          finalPrompt,
          webSearch
        );
    } catch (error) {
      console.error(
        "CareerMitra AI request failed",
        error
      );

      /*
       * IMPORTANT:
       *
       * Live research should NOT become
       * a completely blank panel just because
       * the LLM temporarily hit a rate limit.
       */

      if (
        webSearch &&
        career &&
        sources.length
      ) {
        return res.status(200).json({
          ok: true,

          ai: false,

          fallbackUsed:
            true,

          aiFailed:
            true,

          rateLimited:
            Number(
              error?.status
            ) === 429,

          retryAfter:
            error?.retryAfter ||
            null,

          data:
            webFallbackResearch(
              career,
              sources
            ),

          model:
            null,

          sources,

          warning:
            "Live sources were retrieved, but AI synthesis was temporarily unavailable."
        });
      }

      const status =
        Number(
          error?.status ||
          503
        );

      return res
        .status(
          status === 429
            ? 429
            : 503
        )
        .json({
          ok: false,

          aiFailed:
            true,

          fallbackAllowed:
            true,

          rateLimited:
            status === 429,

          retryAfter:
            error?.retryAfter ||
            null,

          error:
            cleanText(
              error?.message ||
              "AI service temporarily unavailable."
            )
        });
    }


    /* =====================================================
       PARSE AI JSON
    ===================================================== */

    let data =
      parseJSON(
        ai.text
      );


    /* =====================================================
       LIVE RESEARCH RESULT
    ===================================================== */

    if (webSearch) {
      /*
       * If AI returned malformed JSON,
       * don't destroy the research panel.
       */

      data =
        data
          ? normalizeResearch(
              data,
              career,
              sources
            )
          : webFallbackResearch(
              career,
              sources
            );
    }


    /* =====================================================
       SUCCESS RESPONSE
    ===================================================== */

    return res.status(200).json({
      ok: true,

      ai: true,

      fallbackUsed:
        false,

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

    return res.status(503).json({
      ok: false,

      aiFailed:
        true,

      fallbackAllowed:
        true,

      error:
        cleanText(
          error?.message ||
          "AI service temporarily unavailable."
        )
    });
  }
}
