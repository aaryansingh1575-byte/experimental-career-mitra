export const maxDuration = 60;

const OPENROUTER_URL =
  "https://openrouter.ai/api/v1/chat/completions";

const MODELS = [
  process.env.OPENROUTER_MODEL ||
    "nvidia/nemotron-3-ultra-550b-a55b:free",

  "qwen/qwen3-30b-a3b:free",
  "meta-llama/llama-3.3-70b-instruct:free"
];

function cleanText(v) {
  return String(v ?? "")
    .replace(/\u0000/g, "")
    .trim();
}

function stripFence(text) {
  return String(text || "")
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .trim()
    .replace(/\s*```$/i, "")
    .trim();
}

function parseJSON(text) {
  if (!text) return null;

  const cleaned = stripFence(text);

  try {
    return JSON.parse(cleaned);
  } catch (_) {}

  const first = cleaned.indexOf("{");
  const last = cleaned.lastIndexOf("}");

  if (first !== -1 && last > first) {
    try {
      return JSON.parse(cleaned.slice(first, last + 1));
    } catch (_) {}
  }

  const firstArray = cleaned.indexOf("[");
  const lastArray = cleaned.lastIndexOf("]");

  if (firstArray !== -1 && lastArray > firstArray) {
    try {
      return JSON.parse(
        cleaned.slice(firstArray, lastArray + 1)
      );
    } catch (_) {}
  }

  return null;
}

function extractText(data) {
  const choice = data?.choices?.[0];

  if (!choice) return "";

  const content = choice.message?.content;

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

  if (typeof choice.text === "string") {
    return choice.text.trim();
  }

  return "";
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function requestModel(model, messages) {
  const key = process.env.OPENROUTER_API_KEY;

  if (!key) {
    throw new Error(
      "OPENROUTER_API_KEY is missing in Vercel Environment Variables."
    );
  }

  const controller = new AbortController();

  const timer = setTimeout(() => {
    controller.abort();
  }, 25000);

  try {
    const response = await fetch(
      OPENROUTER_URL,
      {
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

          messages,

          temperature: 0.2,

          max_tokens: 5000,

          top_p: 0.9
        }),

        signal: controller.signal
      }
    );

    const raw = await response.text();

    let data;

    try {
      data = JSON.parse(raw);
    } catch (_) {
      data = null;
    }

    if (!response.ok) {
      const error =
        data?.error?.message ||
        data?.error?.code ||
        `HTTP ${response.status}`;

      const err = new Error(cleanText(error));

      err.status = response.status;

      throw err;
    }

    const text = extractText(data);

    if (!text) {
      throw new Error("Empty AI response.");
    }

    return text;

  } finally {
    clearTimeout(timer);
  }
}

/*
  Reliable AI call.

  Strategy:

  1. Try primary model.
  2. Retry primary once.
  3. Try second free model.
  4. Try third free model.
*/
async function callAI(messages) {

  let lastError = null;

  for (let i = 0; i < MODELS.length; i++) {

    const model = MODELS[i];

    for (let attempt = 0; attempt < 2; attempt++) {

      try {

        const result =
          await requestModel(model, messages);

        if (result && result.trim()) {
          return {
            text: result,
            model
          };
        }

      } catch (error) {

        lastError = error;

        console.error(
          `CareerMitra AI failed`,
          {
            model,
            attempt,
            error: error?.message
          }
        );

        /*
          Rate-limit / temporary provider errors:
          wait briefly before retrying.
        */

        if (
          error?.status === 429 ||
          error?.status === 502 ||
          error?.status === 503 ||
          error?.name === "AbortError"
        ) {
          await sleep(700);
        }
      }
    }
  }

  throw lastError ||
    new Error("All AI models failed.");
}

/* ================= CAREER EXTRACTION ================= */

function extractCareer(prompt = "") {

  const p = cleanText(prompt);

  const patterns = [

    /non[- ]negotiable career\s*[:\-]\s*(.+?)(?:\n|$)/i,

    /exact career\s*[:\-]\s*(.+?)(?:\n|$)/i,

    /research this career\s*[:\-]\s*(.+?)(?:\n|$)/i,

    /career of\s*[:\-]\s*(.+?)(?:\n|$)/i,

    /career\s*[:\-]\s*(.+?)(?:\n|$)/i
  ];

  for (const pattern of patterns) {

    const match = p.match(pattern);

    if (match?.[1]) {
      return cleanText(match[1]);
    }
  }

  return "";
}

/* ================= WEB SEARCH ================= */

async function searchWeb(query) {

  const encoded =
    encodeURIComponent(query);

  const url =
    `https://www.google.com/search?q=${encoded}`;

  try {

    const response =
      await fetch(url, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 CareerMitra/1.0"
        }
      });

    if (!response.ok) return "";

    const html =
      await response.text();

    return html
      .replace(
        /<script[\s\S]*?<\/script>/gi,
        " "
      )
      .replace(
        /<style[\s\S]*?<\/style>/gi,
        " "
      )
      .replace(
        /<[^>]+>/g,
        " "
      )
      .replace(
        /\s+/g,
        " "
      )
      .trim()
      .slice(0, 12000);

  } catch (_) {

    return "";
  }
}

/* ================= CAREER RESEARCH PROMPT ================= */

function careerPrompt(career, web) {

  return `
You are CareerMitra's career research engine.

Research this EXACT career:

${career}

WEB MATERIAL:

${web}

Return ONLY valid JSON.

Use EXACTLY this structure:

{
  "career": "${career}",
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

IMPORTANT:

- Do not change the career.
- Do not leave fields empty.
- Use practical India-focused information.
- Salary must be described as indicative.
- Do not invent URLs.
- Public discussion themes are anecdotal.
- Academic education means degree/college route.
- Vocational route means diploma/non-degree route.
- Certifications must be relevant.
- Job-ready skills must be concrete.
- Return JSON only.
`;
}

/* ================= NORMAL TEST ZONE PROMPT ================= */

function normalSystemPrompt() {

  return `
You are CareerMitra's AI engine.

You are generating content for a student career counselling platform.

Follow the user's requested JSON structure EXACTLY.

Rules:

1. Return valid JSON only when JSON is requested.
2. Never wrap JSON in markdown.
3. Never add explanations outside JSON.
4. Keep questions simple and natural.
5. Use the student's Personal Vault when provided.
6. Do not invent facts about the student.
7. Make every generated item usable directly by the frontend.
`;
}

/* ================= MAIN HANDLER ================= */

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

    /* ================= LIVE RESEARCH ================= */

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
        `"${career}" India jobs`,
        `"${career}" India salary`,
        `"${career}" India qualifications`,
        `"${career}" India demand`,
        `"${career}" India future`,
        `"${career}" India education`
      ];

      let web = "";

      for (const query of queries) {

        const result =
          await searchWeb(query);

        if (result) {
          web += "\n\n" + result;
        }

        if (web.length > 40000) break;
      }

      const ai =
        await callAI([
          {
            role: "system",
            content:
              "Return valid JSON only."
          },
          {
            role: "user",
            content:
              careerPrompt(
                career,
                web.slice(0, 40000)
              )
          }
        ]);

      let data =
        parseJSON(ai.text);

      /*
        If the model gave malformed JSON,
        retry once with a stricter instruction.
      */

      if (!data) {

        const retry =
          await callAI([
            {
              role: "system",
              content:
                "You MUST return valid JSON. No markdown. No commentary."
            },
            {
              role: "user",
              content:
                careerPrompt(
                  career,
                  web.slice(0, 25000)
                )
            }
          ]);

        data =
          parseJSON(retry.text);
      }

      if (!data) {
        throw new Error(
          "AI returned invalid career research data."
        );
      }

      data.career = career;

      const arrayFields = [
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
        "sources"
      ];

      for (const field of arrayFields) {

        if (!Array.isArray(data[field])) {
          data[field] = [];
        }
      }

      return res.status(200).json({

        ok: true,

        ai: true,

        fallbackUsed: false,

        data,

        model: ai.model
      });
    }

    /* ================= NORMAL AI ================= */

    const ai =
      await callAI([
        {
          role: "system",
          content:
            normalSystemPrompt()
        },
        {
          role: "user",
          content: prompt
        }
      ]);

    const parsed =
      parseJSON(ai.text);

    return res.status(200).json({

      ok: true,

      ai: true,

      fallbackUsed: false,

      data: parsed || ai.text,

      model: ai.model
    });

  } catch (error) {

    console.error(
      "CareerMitra API ERROR:",
      error
    );

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
