export const maxDuration = 60;

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

const MODELS = [
  process.env.OPENROUTER_MODEL ||
    "nvidia/nemotron-3-ultra-550b-a55b:free",
  "qwen/qwen3-30b-a3b:free",
  "meta-llama/llama-3.3-70b-instruct:free"
];


/* =========================================================
   BASIC HELPERS
   ========================================================= */

function cleanText(value) {
  if (value == null) return "";
  return String(value)
    .replace(/\u0000/g, "")
    .trim();
}


function stripCodeFence(text) {
  return cleanText(text)
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}


function parseJSON(text) {
  if (!text) return null;

  const cleaned = stripCodeFence(text);

  try {
    return JSON.parse(cleaned);
  } catch (_) {}

  const first = cleaned.indexOf("{");
  const last = cleaned.lastIndexOf("}");

  if (first !== -1 && last > first) {
    try {
      return JSON.parse(
        cleaned.slice(first, last + 1)
      );
    } catch (_) {}
  }

  const a = cleaned.indexOf("[");
  const b = cleaned.lastIndexOf("]");

  if (a !== -1 && b > a) {
    try {
      return JSON.parse(
        cleaned.slice(a, b + 1)
      );
    } catch (_) {}
  }

  return null;
}


function extractModelText(data) {
  if (!data) return "";

  return cleanText(
    data?.choices?.[0]?.message?.content ||
    data?.choices?.[0]?.text ||
    ""
  );
}


/* =========================================================
   MODEL REQUEST
   ========================================================= */

async function requestModel(
  model,
  messages,
  options = {}
) {
  const {
    timeout = 25000,
    max_tokens = 5000
  } = options;

  if (!process.env.OPENROUTER_API_KEY) {
    throw new Error(
      "OPENROUTER_API_KEY is not configured."
    );
  }

  const controller = new AbortController();

  const timer = setTimeout(() => {
    controller.abort();
  }, timeout);

  try {

    const response = await fetch(
      OPENROUTER_URL,
      {
        method: "POST",

        headers: {
          "Content-Type": "application/json",
          "Authorization":
            `Bearer ${process.env.OPENROUTER_API_KEY}`,

          "HTTP-Referer":
            process.env.PUBLIC_APP_URL ||
            "https://careermitra.vercel.app",

          "X-Title":
            "CareerMitra"
        },

        body: JSON.stringify({
          model,
          messages,

          temperature: 0.2,

          max_tokens
        }),

        signal: controller.signal
      }
    );

    const raw =
      await response.text();

    let data = null;

    try {
      data = JSON.parse(raw);
    } catch (_) {
      data = null;
    }

    if (!response.ok) {

      const error =
        data?.error?.message ||
        data?.error ||
        `OpenRouter error ${response.status}`;

      const err =
        new Error(String(error));

      err.status =
        response.status;

      throw err;
    }

    const text =
      extractModelText(data);

    if (!text) {
      throw new Error(
        "AI returned empty response."
      );
    }

    return text;

  } finally {
    clearTimeout(timer);
  }
}


/* =========================================================
   AI CALL
   ========================================================= */

async function callAI(
  messages,
  options = {}
) {

  const fast =
    options.fast === true;

  /*
    FAST MODE
    Used by Test Zone.

    One model
    One request
    15 sec timeout
    No retries
  */

  if (fast) {

    try {

      return await requestModel(
        MODELS[0],
        messages,
        {
          timeout: 15000,
          max_tokens:
            options.max_tokens || 4000
        }
      );

    } catch (error) {

      console.error(
        "Fast AI failed:",
        error?.message || error
      );

      return null;
    }
  }


  /*
    NORMAL MODE
    Used for other AI features.
    Allows fallback models.
  */

  let lastError = null;

  for (const model of MODELS) {

    try {

      return await requestModel(
        model,
        messages,
        {
          timeout: 25000,
          max_tokens:
            options.max_tokens || 6000
        }
      );

    } catch (error) {

      lastError = error;

      console.error(
        `Model failed: ${model}`,
        error?.message || error
      );

      /*
        Small delay before trying
        another model.
      */

      await new Promise(
        resolve =>
          setTimeout(resolve, 400)
      );
    }
  }

  throw (
    lastError ||
    new Error("All AI models failed.")
  );
}


/* =========================================================
   CAREER EXTRACTION
   ========================================================= */

function extractCareer(prompt) {

  const p = cleanText(prompt);

  const patterns = [
    /non[- ]negotiable career\s*[:\-]\s*([^\n]+)/i,
    /exact career\s*[:\-]\s*([^\n]+)/i,
    /career\s*[:\-]\s*([^\n]+)/i,
    /career of\s+([^\n]+)/i,
    /research this career\s*[:\-]?\s*([^\n]+)/i
  ];

  for (const regex of patterns) {

    const match =
      p.match(regex);

    if (match?.[1]) {

      return cleanText(
        match[1]
          .replace(/[.]+$/, "")
      );
    }
  }

  return "";
}


/* =========================================================
   WEB SEARCH
   ========================================================= */

async function searchWeb(career) {

  if (!career) return [];

  try {

    const query =
      encodeURIComponent(
        `"${career}" India career salary demand skills`
      );

    const url =
      `https://www.google.com/search?q=${query}`;

    /*
      We do not invent source URLs.
      Search is best-effort and model still
      handles stable career information.
    */

    return [
      {
        title:
          `${career} — public web research`,
        url,
        snippet:
          `Public web search for ${career} in India.`
      }
    ];

  } catch (_) {

    return [];
  }
}


/* =========================================================
   CAREER RESEARCH
   ========================================================= */

async function researchCareer(
  prompt,
  options = {}
) {

  const career =
    extractCareer(prompt);

  const sources =
    options.webSearch
      ? await searchWeb(career)
      : [];

  const sourceText =
    sources.length
      ? sources
          .map(
            s =>
              `SOURCE: ${s.title}\nURL: ${s.url}\n${s.snippet}`
          )
          .join("\n\n")
      : "No live sources retrieved.";


  const researchPrompt = `
You are CareerMitra's career research engine.

Research the EXACT career requested by the user.

CAREER:
${career || "Use the career stated in the request."}

${sourceText}

Return ONLY valid JSON.

Use EXACTLY these keys:

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
  "sources": [],
  "student_fit": "",
  "family_concerns_addressed": []
}

IMPORTANT:

1. The career must remain EXACTLY the requested career.

2. Do not silently replace it with another career.

3. Give useful information even if live sources are limited.

4. Stable/general career descriptions may use professional knowledge.

5. Current claims such as salary and demand should be cautious.

6. Do not leave sections blank when reasonable information can be provided.

7. Do not invent specific statistics.

8. Do not invent URLs.

9. Keep the answer India-focused.

10. Academic education and vocational/diploma routes must both be considered.

11. Include certifications and job-ready skills.

12. Return JSON only.
`;


  const messages = [
    {
      role: "system",
      content:
        "You are CareerMitra's accurate career research assistant. Return valid JSON only."
    },
    {
      role: "user",
      content: researchPrompt
    }
  ];


  const text =
    await callAI(
      messages,
      {
        fast: false,
        max_tokens: 7000
      }
    );

  const result =
    parseJSON(text);

  if (!result) {

    throw new Error(
      "Career research returned invalid JSON."
    );
  }

  /*
    Guarantee frontend-compatible keys.
  */

  const defaults = {
    career:
      career || "Career",

    what_it_involves:
      "This role involves applying relevant knowledge and skills to solve professional problems.",

    pros: [
      "Strong learning opportunities",
      "Multiple career paths"
    ],

    cons: [
      "Requires continuous learning",
      "Competition can be high"
    ],

    pay_india:
      "Salary varies significantly by skills, experience, location and employer.",

    market_requirements: [
      "Relevant education",
      "Practical skills",
      "Projects or experience"
    ],

    demand:
      "Demand depends on industry, location, skills and current hiring conditions.",

    future_growth:
      "Growth depends on continuous skill development and industry demand.",

    step_by_step_path: [
      "Build foundational knowledge",
      "Develop practical skills",
      "Create projects",
      "Gain experience",
      "Apply for relevant roles"
    ],

    academic_education: [
      "Relevant undergraduate degree",
      "Specialization or advanced study where useful"
    ],

    vocational_diploma: [
      "Relevant diploma or vocational training can provide practical entry-level skills."
    ],

    certifications: [
      "Industry-relevant certifications"
    ],

    job_ready_skills: [
      "Communication",
      "Problem solving",
      "Role-specific technical skills"
    ],

    alternatives: [],

    barriers: [
      "Competition",
      "Need for continuous upskilling"
    ],

    rewards: [
      "Professional growth",
      "Skill development",
      "Career opportunities"
    ],

    public_discussion_themes: [
      "Skills and employability",
      "Career growth",
      "Work-life balance"
    ],

    sources: sources.map(
      x => x.url
    ),

    student_fit:
      "Fit depends on the student's interests, strengths, personality and goals.",

    family_concerns_addressed: []
  };


  for (const key of Object.keys(defaults)) {

    if (
      result[key] == null ||
      result[key] === "" ||
      (
        Array.isArray(defaults[key]) &&
        !Array.isArray(result[key])
      )
    ) {
      result[key] =
        defaults[key];
    }
  }


  return {
    data: result,
    sources
  };
}


/* =========================================================
   MAIN VERCEL HANDLER
   ========================================================= */

export default async function handler(
  req,
  res
) {

  if (req.method !== "POST") {

    return res.status(405).json({
      ok: false,
      error: "Method not allowed."
    });
  }


  try {

    const body =
      req.body || {};

    const prompt =
      cleanText(body.prompt);

    const webSearch =
      body.webSearch === true;

    const fast =
      body.fast === true;


    if (!prompt) {

      return res.status(400).json({
        ok: false,
        error: "Prompt is required."
      });
    }


    /* -----------------------------------------
       LIVE CAREER RESEARCH
       ----------------------------------------- */

    if (
      webSearch ||
      /live career research|research this career|internet research|web research/i
        .test(prompt)
    ) {

      const result =
        await researchCareer(
          prompt,
          {
            webSearch: true
          }
        );

      return res.status(200).json({
        ok: true,
        data: result.data,
        sources: result.sources
      });
    }


    /* -----------------------------------------
       NORMAL / TEST ZONE AI
       ----------------------------------------- */

    const messages = [

      {
        role: "system",
        content:
          `You are CareerMitra's AI engine.

Follow the user's instructions exactly.

If JSON is requested, return ONLY valid JSON.

Do not wrap JSON in markdown fences.`
      },

      {
        role: "user",
        content: prompt
      }

    ];


    const text =
      await callAI(
        messages,
        {
          fast,
          max_tokens:
            fast ? 4000 : 6000
        }
      );


    if (!text) {

      return res.status(503).json({
        ok: false,
        aiFailed: true,
        fallbackAllowed: true,
        error:
          "AI request failed."
      });
    }


    const parsed =
      parseJSON(text);


    /*
      Test Zone expects JSON.
      If model returned JSON,
      send parsed object.
    */

    if (parsed) {

      return res.status(200).json({
        ok: true,
        data: parsed
      });
    }


    /*
      For non-JSON responses,
      return the text safely.
    */

    return res.status(200).json({
      ok: true,
      data: {
        text
      }
    });


  } catch (error) {

    console.error(
      "CareerMitra API error:",
      error
    );

    return res.status(503).json({

      ok: false,

      aiFailed: true,

      fallbackAllowed: true,

      error:
        error?.message ||
        "AI service temporarily unavailable."
    });
  }
}
