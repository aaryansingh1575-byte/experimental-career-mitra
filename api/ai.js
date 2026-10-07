export const maxDuration = 10;

const cleanText = (v, max = 12000) =>
  String(v ?? "")
    .replace(/\0/g, "")
    .slice(0, max)
    .trim();

function extractCareer(body = {}) {
  return cleanText(
    body.career ||
      body.careerName ||
      body.role ||
      body.anchorCareer ||
      body.query ||
      "career"
  , 300);
}

function isBadResult(data) {
  if (!data) return true;

  const text = typeof data === "string"
    ? data
    : JSON.stringify(data);

  return (
    text.length < 40 ||
    /unable to|cannot provide|error|failed to search/i.test(text)
  );
}

async function searchWeb(query) {
  const q = encodeURIComponent(cleanText(query, 500));

  try {
    const response = await fetch(
      `https://www.google.com/search?q=${q}`,
      {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/154 Safari/537.36"
        }
      }
    );

    if (!response.ok) return [];

    const html = await response.text();

    const results = [];
    const regex =
      /<a href="(https?:\/\/[^"]+)"[^>]*>(.*?)<\/a>/gi;

    let match;

    while ((match = regex.exec(html)) && results.length < 8) {
      const url = match[1];

      if (
        url.includes("google.com") ||
        url.includes("accounts.google") ||
        url.includes("support.google")
      ) {
        continue;
      }

      const title = match[2]
        .replace(/<[^>]+>/g, "")
        .replace(/&amp;/g, "&")
        .replace(/&#39;/g, "'")
        .replace(/&quot;/g, '"')
        .trim();

      if (title && url) {
        results.push({
          title,
          url
        });
      }
    }

    return results;
  } catch {
    return [];
  }
}

function sourcePriority(url = "") {
  const u = url.toLowerCase();

  if (
    u.includes(".gov.in") ||
    u.includes("gov.in") ||
    u.includes("ncs.gov.in")
  ) return 10;

  if (
    u.includes("ugc.gov.in") ||
    u.includes("aicte-india.org") ||
    u.includes("education.gov.in")
  ) return 9;

  if (
    u.includes("linkedin.com") ||
    u.includes("indeed.com")
  ) return 6;

  if (
    u.includes("ambitionbox.com") ||
    u.includes("glassdoor.co")
  ) return 5;

  return 3;
}

function extractModelText(data) {
  if (!data) return "";

  if (typeof data === "string") return data;

  if (data.choices?.[0]?.message?.content) {
    return data.choices[0].message.content;
  }

  if (data.choices?.[0]?.text) {
    return data.choices[0].text;
  }

  return "";
}

function parseJSON(text) {
  if (!text) return null;

  let cleaned = text
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch {}

  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");

  if (start !== -1 && end > start) {
    try {
      return JSON.parse(cleaned.slice(start, end + 1));
    } catch {}
  }

  return null;
}

async function callAI(prompt) {
  const key = process.env.OPENROUTER_API_KEY;

  if (!key) {
    throw new Error("OPENROUTER_API_KEY is not configured");
  }

  const model =
    process.env.OPENROUTER_MODEL ||
    "nvidia/nemotron-3-ultra-550b-a55b:free";

  const response = await fetch(
    "https://openrouter.ai/api/v1/chat/completions",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
        "HTTP-Referer":
          process.env.APP_URL || "https://careermitra.vercel.app",
        "X-Title": "CareerMitra"
      },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        max_tokens: 5000,
        messages: [
          {
            role: "system",
            content:
              "You are CareerMitra, an AI career counselling and family decision-support assistant. Give practical, balanced, India-relevant career information. Never silently replace a student's explicitly chosen non-negotiable career."
          },
          {
            role: "user",
            content: prompt
          }
        ]
      })
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `OpenRouter error ${response.status}: ${errorText.slice(0, 500)}`
    );
  }

  return response.json();
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      ok: false,
      error: "Method not allowed"
    });
  }

  try {
    const body = req.body || {};

    const career = extractCareer(body);

    const webSearch =
      body.webSearch === true ||
      body.webSearch === "true";

    let sources = [];

    if (webSearch) {
      sources = await searchWeb(
        `${career} India career education salary demand skills future scope`
      );

      sources = sources
        .sort(
          (a, b) =>
            sourcePriority(b.url) -
            sourcePriority(a.url)
        )
        .slice(0, 8);
    }

    const sourceText = sources.length
      ? sources
          .map(
            (s, i) =>
              `${i + 1}. ${s.title}\nURL: ${s.url}`
          )
          .join("\n\n")
      : "No live web sources were found.";

    const prompt = `
Research and explain the following career for a student in India:

CAREER:
${career}

${body.studentProfile
  ? `STUDENT PROFILE:
${cleanText(JSON.stringify(body.studentProfile), 12000)}`
  : ""}

${body.vault
  ? `PERSONAL VAULT:
${cleanText(JSON.stringify(body.vault), 12000)}`
  : ""}

${body.familyConcerns
  ? `FAMILY CONCERNS:
${cleanText(JSON.stringify(body.familyConcerns), 12000)}`
  : ""}

LIVE WEB SOURCES:
${sourceText}

Return ONLY valid JSON with this structure:

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
  "family_concerns_addressed": [],
  "sources": []
}

Rules:
- Keep salary clearly labelled as indicative.
- Prefer India-specific information.
- Separate academic and vocational/diploma routes.
- Mention realistic skills needed for entry-level jobs.
- Do not invent exact facts when evidence is unavailable.
- If live sources were provided, use them as supporting references.
- Keep the student's non-negotiable career intact.
`;

    const aiResponse = await callAI(prompt);

    const modelText = extractModelText(aiResponse);

    let data = parseJSON(modelText);

    if (!data) {
      data = {
        career,
        answer: modelText
      };
    }

    if (isBadResult(data)) {
      return res.status(502).json({
        ok: false,
        error: "AI returned an unusable result",
        sources
      });
    }

    if (!data.sources || !Array.isArray(data.sources)) {
      data.sources = sources;
    }

    return res.status(200).json({
      ok: true,
      data,
      sources
    });
  } catch (error) {
    console.error("CareerMitra AI error:", error);

    return res.status(500).json({
      ok: false,
      error:
        error?.message ||
        "CareerMitra AI request failed"
    });
  }
}
