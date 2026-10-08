// api/ai.js

export const maxDuration = 60;

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

const PRIMARY_MODEL =
  process.env.OPENROUTER_MODEL ||
  "nvidia/nemotron-3-ultra-550b-a55b:free";

const FALLBACK_MODELS = [
  PRIMARY_MODEL,
  "nvidia/nemotron-3.5-lightning:free",
  "nvidia/nemotron-3-super-120b-a12b:free",
  "openrouter/free"
].filter((v, i, a) => v && a.indexOf(v) === i);

const MAX_ATTEMPTS = 3;

function cleanText(value) {
  return String(value ?? "")
    .replace(/\u0000/g, "")
    .trim();
}

function stripFence(text) {
  return cleanText(text)
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .trim();
}

function parseJSON(text) {
  const raw = stripFence(text);

  try {
    return JSON.parse(raw);
  } catch {}

  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");

  if (start >= 0 && end > start) {
    try {
      return JSON.parse(raw.slice(start, end + 1));
    } catch {}
  }

  const arrStart = raw.indexOf("[");
  const arrEnd = raw.lastIndexOf("]");

  if (arrStart >= 0 && arrEnd > arrStart) {
    try {
      return JSON.parse(raw.slice(arrStart, arrEnd + 1));
    } catch {}
  }

  return null;
}

function extractText(data) {
  const choice = data?.choices?.[0];

  if (!choice) return "";

  const content = choice.message?.content;

  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map(x => {
        if (typeof x === "string") return x;
        return x?.text || "";
      })
      .join("");
  }

  return "";
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/*
  -------------------------------------------------------
  RATE-LIMIT SAFE AI REQUEST
  -------------------------------------------------------
*/

async function requestAI(prompt, options = {}) {
  const {
    webSearch = false,
    maxAttempts = MAX_ATTEMPTS
  } = options;

  const apiKey = process.env.OPENROUTER_API_KEY;

  if (!apiKey) {
    const err = new Error("OPENROUTER_API_KEY is missing.");
    err.code = "MISSING_API_KEY";
    throw err;
  }

  let lastError = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const model =
      FALLBACK_MODELS[Math.min(attempt, FALLBACK_MODELS.length - 1)];

    const controller = new AbortController();

    const timeout = setTimeout(
      () => controller.abort(),
      webSearch ? 15000 : 12000
    );

    try {
      const systemPrompt = `
You are the core AI engine of CareerMitra.

Your behaviour must ALWAYS be:

- neutral
- unbiased
- evidence-based
- polite
- soft-spoken
- easy to understand
- student-centred
- family-sensitive
- non-judgmental
- non-directive

IMPORTANT:

Never promote a career because it is popular.

Never promote a career because it has high salary.

Never assume engineering, medicine, government jobs, aviation, software, AI, business, or any other field is better.

Never infer a student's desired career unless the student's supplied data actually supports it.

Never manufacture information that the user did not provide.

When analysing a student, use their actual Personal Vault, Test Zone responses and other supplied information.

When analysing family responses, use the actual family answers.

Do not convert generic statements such as:
"I support whatever he wants"
"money is no problem"
"I don't care"
"no issue"
into evidence for a specific career.

If evidence is insufficient, say so.

The purpose of CareerMitra is decision support, NOT forcing a career choice.

Use simple language.
`;

      const body = {
        model,

        messages: [
          {
            role: "system",
            content: systemPrompt
          },
          {
            role: "user",
            content: prompt
          }
        ],

        temperature: webSearch ? 0.05 : 0.15,

        max_tokens: webSearch ? 6500 : 6000,

        provider: {
          allow_fallbacks: true,
          sort: "throughput"
        }
      };

      /*
        Optional web search mode.
        The frontend can still send the research prompt with
        webSearch=true. The backend keeps the same AI interface.
      */

      if (webSearch) {
        body.plugins = [
          {
            id: "web",
            max_results: 8
          }
        ];
      }

      const response = await fetch(OPENROUTER_URL, {
        method: "POST",

        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`,
          "HTTP-Referer":
            process.env.APP_URL ||
            process.env.VERCEL_URL ||
            "https://careermitra.vercel.app",
          "X-Title": "CareerMitra"
        },

        body: JSON.stringify(body),

        signal: controller.signal
      });

      clearTimeout(timeout);

      const text = await response.text();

      let data = null;

      try {
        data = JSON.parse(text);
      } catch {
        data = null;
      }

      if (!response.ok) {
        const message =
          data?.error?.message ||
          text ||
          `OpenRouter returned ${response.status}`;

        const error = new Error(message);

        error.status = response.status;

        /*
          Retry only transient failures.
        */

        const retryable = [
          408,
          409,
          425,
          429,
          500,
          502,
          503,
          504
        ].includes(response.status);

        if (!retryable) {
          throw error;
        }

        lastError = error;

        /*
          Small bounded backoff.
          Do NOT spam the provider.
        */

        if (attempt < maxAttempts - 1) {
          await sleep(350 * (attempt + 1));
          continue;
        }

        throw error;
      }

      const output = extractText(data);

      if (!output) {
        lastError = new Error("AI returned an empty response.");

        if (attempt < maxAttempts - 1) {
          await sleep(300 * (attempt + 1));
          continue;
        }

        throw lastError;
      }

      return {
        text: output,
        model,
        attempt: attempt + 1,
        fallbackUsed: attempt > 0
      };

    } catch (error) {
      clearTimeout(timeout);

      lastError = error;

      if (error?.name === "AbortError") {
        lastError = new Error(
          "AI request timed out."
        );
      }

      if (attempt < maxAttempts - 1) {
        await sleep(300 * (attempt + 1));
        continue;
      }
    }
  }

  throw lastError || new Error("AI request failed.");
}


/*
  -------------------------------------------------------
  TEST ZONE
  -------------------------------------------------------
*/

function testZonePrompt(prompt) {
  return `
You are generating the Student Test Zone for CareerMitra.

The Personal Vault below belongs to ONE specific student.

You MUST use this student's actual information.

PERSONAL VAULT:

${prompt}

YOUR TASK:

Generate a complete 25-question assessment.

The questions must be PERSONALIZED from the supplied Vault.

Do NOT generate generic questions that could have been given to any student.

Do NOT assume a career.

Do NOT favour any career category.

Do NOT repeatedly ask about the same interest.

Do NOT simply ask:
"Do you like X?"
again and again.

Instead, understand the student's information and create realistic situations, preferences and choices around it.

QUESTION DISTRIBUTION:

Interests: 5
Hobbies / Activities: 4
Strong Subjects: 4
Career / Role Preferences: 5
Skills / Strengths: 4
Work Style / Personality: 3

TOTAL: exactly 25 questions.

IMPORTANT:

The first five categories MUST be grounded in the actual Vault.

Each question must contain:

{
  "id": 1,
  "category": "Interests",
  "question": "...",
  "options": [
    "...",
    "...",
    "...",
    "..."
  ],
  "basedOn": "...",
  "traitMap": {
    "R": 0,
    "I": 0,
    "A": 0,
    "S": 0,
    "E": 0,
    "C": 0
  }
}

RULES FOR OPTIONS:

- exactly 4 options
- all options must be plausible
- all options must be similar in quality
- no obviously correct answer
- no obviously bad answer
- no option should secretly mean "choose the recommended career"
- avoid emotional manipulation
- avoid salary-only framing
- avoid prestige framing
- avoid socially desirable answers
- avoid leading wording

The four options should represent different legitimate preferences.

For example, do NOT make:

A. The smart option
B. The boring option
C. The risky option
D. The useless option

Instead make all four reasonable.

TRAIT MAP:

Use Holland-style RIASEC dimensions.

R = Realistic
I = Investigative
A = Artistic
S = Social
E = Enterprising
C = Conventional

Use small values such as:

0
1
2

Do not make every question map heavily to the same trait.

IMPORTANT:

A question can be based on a student's interest without assuming that interest must become their career.

A hobby is evidence of preference, NOT proof of career choice.

A strong subject is evidence of comfort/ability, NOT proof of career choice.

A preferred role is evidence of stated preference, NOT proof of suitability.

Return ONLY JSON.

FORMAT:

{
  "questions": [
    {
      "id": 1,
      "category": "Interests",
      "question": "...",
      "options": ["...", "...", "...", "..."],
      "basedOn": "...",
      "traitMap": {
        "R": 0,
        "I": 1,
        "A": 0,
        "S": 0,
        "E": 1,
        "C": 0
      }
    }
  ]
}
`;
}


/*
  -------------------------------------------------------
  LIVE CAREER RESEARCH
  -------------------------------------------------------
*/

function researchPrompt(prompt) {
  return `
You are CareerMitra's live career research analyst.

Research the EXACT career supplied by the student.

Do not replace it with a broader career.

Do not silently change the specialization.

Use India-focused information wherever possible.

Prefer:

- NMC
- NBEMS
- NBE
- MCC
- AIIMS
- Government of India
- .gov.in
- .ac.in
- major Indian hospitals
- professional associations
- reputable Indian employment sources

Avoid foreign salary data when answering Indian students unless clearly marked as international context.

Return balanced information.

Include:

1. What the career involves
2. Pros
3. Cons
4. India pay
5. Market requirements
6. Current demand
7. Future growth
8. Step-by-step education path
9. Same-level alternatives
10. Struggles and barriers
11. Rewards beyond money
12. Public discussion themes
13. Family concerns that the available evidence can actually address
14. Sources

Never invent salary figures.

Never claim that a career is "best".

Never guarantee employment.

Return ONLY JSON.

Expected format:

{
  "career": "...",
  "what_it_involves": "...",
  "pros": [],
  "cons": [],
  "pay_india": "...",
  "market_requirements": "...",
  "demand": "...",
  "future_growth": "...",
  "step_by_step_path": [],
  "same_level_alternatives": [],
  "struggles_barriers": [],
  "rewards_beyond_money": [],
  "public_discussion_themes": [],
  "family_concerns_addressed": [],
  "sources": []
}

STUDENT REQUEST:

${prompt}
`;
}


/*
  -------------------------------------------------------
  FAMILY ANALYSIS
  -------------------------------------------------------
*/

function familyPrompt(prompt) {
  return `
You are CareerMitra's Family Perspective AI analyst.

Analyse the family's actual answers.

Do NOT assume what the family means.

Do NOT convert generic support into career preference.

For example:

"I support whatever he wants"

does NOT mean:

"Family supports software engineering."

Similarly:

"salary is no problem"

does NOT mean:

"Family prefers high-paying careers."

Identify:

- explicit career preferences
- genuine concerns
- financial concerns
- stability concerns
- education concerns
- location concerns
- work-life concerns
- future concerns
- competition concerns
- social concerns
- general support statements
- neutral statements

Use the parent's actual wording.

Keep the tone respectful and easy to understand.

Do not judge the parent.

Do not judge the student.

Return JSON only.

STUDENT:

${prompt}

FORMAT:

{
  "concerns": [
    {
      "question": "...",
      "answer": "...",
      "type": "explicit_preference|concern|support|neutral",
      "dimensions": [],
      "importance": "low|medium|high"
    }
  ]
}
`;
}


/*
  -------------------------------------------------------
  COMMON GROUND
  -------------------------------------------------------
*/

function commonGroundPrompt(prompt) {
  return `
You are CareerMitra's neutral Common Ground AI.

You are comparing TWO sides:

1. Student evidence
2. Family evidence

You must NEVER force three careers.

If only one or two careers genuinely fit, return only one or two.

If none fit, return an empty list.

A career is eligible only if:

- there is real student evidence
AND
- there is real family evidence or a family concern that the career genuinely addresses.

Generic family support is NOT career evidence.

Examples:

"I support whatever he wants"
"I trust him"
"money is no problem"
"no limit"
"I don't care about society"

must NOT be used to support any particular career.

Use the student's Test Zone results.

Use the Personal Vault.

Use actual family answers.

Use actual career data.

If there is a conflict, SHOW IT.

Do not hide conflicts simply to make the result look positive.

The student's non-negotiable career must remain separately visible.

It must not automatically win.

Return JSON only.

INPUT:

${prompt}

FORMAT:

{
  "picks": [
    {
      "career": "...",
      "studentEvidence": [],
      "familyEvidence": [],
      "conflicts": [],
      "fit": "Strong|Moderate",
      "reason": "..."
    }
  ]
}
`;
}


/*
  -------------------------------------------------------
  REQUEST CLASSIFICATION
  -------------------------------------------------------
*/

function purposeFor(prompt = "") {
  const p = prompt.toLowerCase();

  if (
    p.includes("25 questions") ||
    p.includes("test zone") ||
    p.includes("personal vault") ||
    p.includes("traitmap") ||
    p.includes("generate questions")
  ) {
    return "test";
  }

  if (
    p.includes("family perspective") ||
    p.includes("parent") ||
    p.includes("family concern")
  ) {
    return "family";
  }

  if (
    p.includes("common ground") ||
    p.includes("intersection") ||
    p.includes("student evidence")
  ) {
    return "common-ground";
  }

  if (
    p.includes("live career research") ||
    p.includes("current demand") ||
    p.includes("india pay") ||
    p.includes("market requirements")
  ) {
    return "research";
  }

  return "general";
}


/*
  -------------------------------------------------------
  MAIN HANDLER
  -------------------------------------------------------
*/

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      ok: false,
      error: "Method not allowed."
    });
  }

  try {
    const {
      prompt = "",
      webSearch = false
    } = req.body || {};

    const cleanPrompt = cleanText(prompt);

    if (!cleanPrompt) {
      return res.status(400).json({
        ok: false,
        error: "Prompt is required."
      });
    }

    const purpose = purposeFor(cleanPrompt);

    let finalPrompt = cleanPrompt;

    /*
      We keep the frontend prompt intact because the frontend
      already sends the complete Vault context.

      These purpose-specific wrappers strengthen the behaviour
      without replacing the student's actual data.
    */

    if (purpose === "test") {
      finalPrompt = testZonePrompt(cleanPrompt);
    }

    if (purpose === "family") {
      finalPrompt = familyPrompt(cleanPrompt);
    }

    if (purpose === "common-ground") {
      finalPrompt = commonGroundPrompt(cleanPrompt);
    }

    if (purpose === "research" || webSearch) {
      finalPrompt = researchPrompt(cleanPrompt);
    }

    let result;

    try {
      result = await requestAI(finalPrompt, {
        webSearch,
        maxAttempts: MAX_ATTEMPTS
      });
    } catch (error) {
      console.error("CareerMitra AI failed:", {
        purpose,
        message: error?.message,
        status: error?.status
      });

      /*
        IMPORTANT:

        We DO NOT fabricate AI output here.

        The frontend can decide whether to perform its own
        last-resort fallback.
      */

      const status =
        error?.status === 429
          ? 429
          : 503;

      return res.status(status).json({
        ok: false,
        error:
          error?.message ||
          "AI service temporarily unavailable.",
        code:
          error?.status === 429
            ? "RATE_LIMIT"
            : "AI_UNAVAILABLE",
        fallbackAllowed: true
      });
    }

    const parsed = parseJSON(result.text);

    /*
      AI returned text but not valid JSON.
      Do not pretend this is a valid structured result.
    */

    if (!parsed) {
      return res.status(502).json({
        ok: false,
        error: "AI returned an invalid structured response.",
        code: "INVALID_AI_JSON",
        fallbackAllowed: true,
        raw: result.text.slice(0, 4000)
      });
    }

    /*
      Successful AI response.
    */

    return res.status(200).json({
      ok: true,
      data: parsed,

      /*
        Useful to the frontend for the green/orange indicator.
      */

      aiGenerated: true,

      model: result.model,

      /*
        This does NOT mean built-in fallback.
        It only means the first provider/model attempt
        failed and another AI model/provider succeeded.
      */

      providerRetryUsed: Boolean(result.fallbackUsed),

      attempts: result.attempt,

      purpose
    });

  } catch (error) {
    console.error("CareerMitra /api/ai fatal error:", error);

    return res.status(500).json({
      ok: false,
      error: "Unexpected AI service error.",
      code: "SERVER_ERROR",
      fallbackAllowed: true
    });
  }
}
