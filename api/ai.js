export const maxDuration = 60;

const OPENROUTER_URL =
  "https://openrouter.ai/api/v1/chat/completions";

// Primary model. Can be overridden from Vercel:
// OPENROUTER_MODEL
const PRIMARY_MODEL =
  process.env.OPENROUTER_MODEL ||
  "nvidia/nemotron-3-ultra-550b-a55b:free";

const FALLBACK_MODELS = [
  PRIMARY_MODEL,
  "nvidia/nemotron-3.5-lightning:free",
  "nvidia/nemotron-3-super-120b-a12b:free",
  "openrouter/free"
].filter(
  (v, i, a) =>
    v && a.indexOf(v) === i
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

function purposeFor(
  prompt,
  webSearch
) {
  const p =
    String(prompt || "")
      .toLowerCase();

  if (webSearch)
    return "live career research";

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
    return "family question and answer analysis";
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
   OPENROUTER AI
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
- use the supplied student/family data strictly
- do not invent personal information
- do not invent family concerns
- do not invent student preferences
- do not silently replace the student's non-negotiable career

For live research:
- keep the exact career
- use supplied web evidence for current claims
- focus on India
- never invent URLs
- never invent salaries
- never invent qualifications
- never invent market statistics

If evidence is insufficient,
say that in the JSON instead of guessing.
`;

  /*
   * AI IS THE PRIMARY PATH.
   *
   * We deliberately give AI several attempts.
   * Fallback is only reached after these attempts fail.
   */
  const MAX_ATTEMPTS = 3;

  /*
   * Keep each request bounded so Vercel's
   * function does not hang forever.
   */
  const timeoutMs =
    webSearch
      ? 14500
      : 11000;

  let lastError = null;

  for (
    let attempt = 1;
    attempt <= MAX_ATTEMPTS;
    attempt++
  ) {
    const controller =
      new AbortController();

    const timer =
      setTimeout(
        () =>
          controller.abort(),
        timeoutMs
      );

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

            body:
              JSON.stringify({
                model:
                  PRIMARY_MODEL,

                /*
                 * OpenRouter can choose another
                 * model if the first is unavailable.
                 */
                models:
                  FALLBACK_MODELS,

                messages: [
                  {
                    role: "system",
                    content:
                      system
                  },
                  {
                    role: "user",
                    content:
                      prompt
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
          PRIMARY_MODEL,

        attempts:
          attempt
      };

    } catch (error) {
      lastError =
        error;

      const status =
        Number(
          error?.status || 0
        );

      const transient =
        !status ||
        [
          408,
          409,
          425,
          429,
          500,
          502,
          503,
          504
        ].includes(status);

      if (
        attempt <
          MAX_ATTEMPTS &&
        transient
      ) {
        /*
         * Small bounded backoff.
         *
         * We intentionally don't wait for
         * the complete provider Retry-After
         * because Vercel has a finite runtime.
         */
        const wait =
          Math.min(
            900,
            250 * attempt
          );

        await new Promise(
          resolve =>
            setTimeout(
              resolve,
              wait
            )
        );

        continue;
      }

      break;

    } finally {
      clearTimeout(timer);
    }
  }

  throw (
    lastError ||
    new Error(
      "AI service temporarily unavailable."
    )
  );
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

  for (
    const re of patterns
  ) {
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

  let score = 20;

  if (
    u.includes(
      "nmc.org.in"
    )
  ) {
    score = 120;

  } else if (
    u.includes(
      "natboard.edu.in"
    )
  ) {
    score = 118;

  } else if (
    u.includes(
      "nbe.edu.in"
    )
  ) {
    score = 118;

  } else if (
    u.includes(
      "mcc.nic.in"
    )
  ) {
    score = 116;

  } else if (
    u.includes(
      "aiimsexams.ac.in"
    )
  ) {
    score = 114;

  } else if (
    u.includes(
      "aiims.edu"
    )
  ) {
    score = 112;

  } else if (
    u.includes(
      ".gov.in"
    )
  ) {
    score = 100;

  } else if (
    u.includes(
      "apollohospitals.com"
    )
  ) {
    score = 95;

  } else if (
    u.includes(
      "fortishealthcare.com"
    )
  ) {
    score = 93;

  } else if (
    u.includes(
      "maxhealthcare.in"
    )
  ) {
    score = 93;

  } else if (
    u.includes(
      "medanta.org"
    )
  ) {
    score = 93;

  } else if (
    u.includes(
      "in.indeed.com"
    )
  ) {
    score = 88;

  } else if (
    u.includes(
      "naukri.com"
    )
  ) {
    score = 82;

  } else if (
    u.includes(
      ".ac.in"
    )
  ) {
    score = 90;

  } else if (
    u.includes(
      "linkedin.com"
    )
  ) {
    score = 70;

  } else if (
    u.includes(
      "who.int"
    )
  ) {
    score = 65;
  }

  return score;
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
      encodeURIComponent(
        query
      );

    const r =
      await fetch(
        url,
        {
          headers: {
            "User-Agent":
              "Mozilla/5.0 CareerMitra/1.0"
          }
        }
      );

    if (!r.ok)
      return [];

    const xml =
      await r.text();

    const items =
      xml.match(
        /<item>[\s\S]*?<\/item>/gi
      ) || [];

    return items
      .slice(0, 10)
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

        const clean =
          v =>
            String(v || "")
              .replace(
                /<!\[CDATA\[|\]\]>/g,
                ""
              )
              .replace(
                /&amp;/g,
                "&"
              )
              .replace(
                /&quot;/g,
                '"'
              )
              .replace(
                /&#39;/g,
                "'"
              )
              .replace(
                /<[^>]+>/g,
                " "
              )
              .trim();

        return {
          title:
            clean(title),

          url:
            clean(link),

          snippet:
            clean(snippet)
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
You are CareerMitra's LIVE career research engine
for an Indian student.

EXACT CAREER:
${career}

COUNTRY:
INDIA

CURRENT WEB EVIDENCE:
${evidence ||
"No usable live source was retrieved."}

Return ONLY valid JSON.

Required structure:

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

STRICT RULES:

1. Keep the EXACT career.

2. Never silently replace it with:
   - a broader career
   - a similar career
   - another specialization
   - an alternative career

3. India-focused information is mandatory.

4. Use current web evidence for:
   - salary
   - demand
   - market
   - current requirements
   - current trends

5. Stable educational/role information
   may use reliable professional knowledge.

6. NEVER invent URLs.

7. NEVER invent salary figures.

8. Salary must be presented as indicative
   and dependent on experience, location,
   employer and specialization.

9. Public discussion themes are anecdotal.
   Never present them as survey statistics.

10. If evidence is insufficient,
    explicitly say so.

11. Do not put raw search-result titles
    into unrelated sections.

12. Synthesize the evidence into useful
    career information.

13. Return JSON ONLY.
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
    typeof data ===
      "object"
      ? {
          ...data
        }
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
    const [
      key,
      list
    ] of Object.entries(
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
   WORST-CASE LIVE RESEARCH FALLBACK
========================================================= */

function webFallbackResearch(
  career,
  sources
) {
  const usable =
    sources.slice(
      0,
      12
    );

  const sourceList =
    usable.map(x => ({
      title:
        x.title,

      url:
        x.url,

      snippet:
        x.snippet
    }));

  const indiaSources =
    usable.filter(x => {
      const u =
        x.url.toLowerCase();

      return /nmc.org.in|natboard.edu.in|aiimsexams.ac.in|\.gov.in|apollohospitals.com|fortishealthcare.com|medanta.org|in\.indeed.com|naukri.com/
        .test(u);
    });

  const snippets =
    usable
      .map(
        x =>
          x.snippet
      )
      .filter(Boolean);

  return normalizeResearch(
    {
      career,

      what_it_involves:
        `The exact career is ${career}. Current India-focused sources were retrieved, but AI synthesis was temporarily unavailable.`,

      pros: [
        "Career-specific opportunities should be evaluated from the verified sources.",
        "Specialisation can create opportunities to build domain expertise."
      ],

      cons: [
        "The exact current trade-offs could not be safely synthesized because AI analysis was unavailable."
      ],

      pay_india:
        snippets.length
          ? "Current India source evidence was retrieved, but no salary figure is shown because the AI could not safely reconcile differences between experience, employer and location."
          : "No reliable current India salary evidence was retrieved.",

      market_requirements:
        indiaSources
          .slice(0, 6)
          .map(
            x =>
              `${x.title}${x.snippet ? ` — ${x.snippet}` : ""}`
          ),

      demand:
        `Current India-focused results were retrieved for ${career}. Demand varies by location, employer, experience and specialization.`,

      future_growth:
        "Current source evidence is available below, but an unsupported future forecast is not generated.",

      step_by_step_path: [],

      academic_education: [],

      vocational_diploma: [],

      certifications: [],

      job_ready_skills: [],

      alternatives: [],

      barriers: [],

      rewards: [],

      public_discussion_themes: [],

      student_fit:
        "AI synthesis was unavailable, so no unsupported student-fit claim is made.",

      family_concerns_addressed: [],

      sources:
        sourceList

    },
    career,
    sourceList
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
    return res.status(
      405
    ).json({
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
            req.body ||
              "{}"
          )
        : (
            req.body ||
            {}
          );

    const prompt =
      cleanText(
        body.prompt
      );

    const webSearch =
      body.webSearch ===
      true;

    const suppliedCareer =
      cleanText(
        body.career
      );

    if (!prompt) {
      return res.status(
        400
      ).json({
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
        return res.status(
          400
        ).json({
          ok: false,
          error:
            "Could not determine the exact career."
        });
      }

      /*
       * Multiple India-focused searches.
       */

      const queries = [

        `"${career}" India qualifications education pathway site:nmc.org.in OR site:natboard.edu.in OR site:aiimsexams.ac.in`,

        `"${career}" India specialist training fellowship site:apollohospitals.com OR site:fortishealthcare.com OR site:medanta.org`,

        `"${career}" India jobs salary site:in.indeed.com OR site:naukri.com`,

        `"${career}" India demand jobs market`,

        `"${career}" India future growth technology healthcare`,

        `"${career}" India registration license requirements site:nmc.org.in OR site:gov.in`,

        `"${career}" India professional association fellowship`,

        `"${career}" India day to day responsibilities`
      ];

      const groups =
        await Promise.all(
          queries.map(
            searchWeb
          )
        );

      const seen =
        new Set();

      /*
       * Remove obvious foreign local-service
       * results.
       */
      const badCountry =
        /melbourne|florida|australia|canada|united states|new york|california|uk orthopedic surgeon jobs/i;

      sources =
        groups
          .flat()
          .filter(x => {

            if (
              !x.url ||
              seen.has(
                x.url
              )
            ) {
              return false;
            }

            const combined =
              `${x.title} ${x.snippet}`;

            if (
              badCountry.test(
                combined
              ) &&
              !/india|indian/i.test(
                combined
              )
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
          .slice(
            0,
            20
          );

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
       AI
    ===================================================== */

    let ai;

    try {

      ai =
        await requestAI(
          finalPrompt,
          webSearch
        );

    } catch (
      error
    ) {

      console.error(
        "CareerMitra AI request failed",
        error
      );

      /*
       * IMPORTANT:
       *
       * Fallback is ONLY reached after
       * all AI attempts fail.
       *
       * For live research we still preserve
       * the live source evidence.
       */

      if (
        webSearch &&
        career &&
        sources.length
      ) {

        return res.status(
          200
        ).json({
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
            "All AI recovery attempts failed. Worst-case fallback activated."
        });
      }

      const status =
        Number(
          error?.status ||
          503
        );

      return res.status(
        status === 429
          ? 429
          : 503
      ).json({
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
       LIVE RESEARCH
    ===================================================== */

    if (
      webSearch
    ) {

      /*
       * AI succeeded but returned malformed JSON.
       *
       * We don't make this look like an AI result.
       * Since all AI attempts already completed,
       * worst-case fallback is used.
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
       SUCCESS
    ===================================================== */

    return res.status(
      200
    ).json({
      ok: true,

      ai: true,

      fallbackUsed:
        false,

      data:
        data ||
        ai.text,

      model:
        ai.model,

      attempts:
        ai.attempts,

      sources
    });

  } catch (
    error
  ) {

    console.error(
      "CareerMitra API ERROR",
      error
    );

    return res.status(
      503
    ).json({
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
