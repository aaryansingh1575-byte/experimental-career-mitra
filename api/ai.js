export const maxDuration = 60;

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

const PRIMARY_MODEL = process.env.OPENROUTER_MODEL || "openai/gpt-4o-mini";
const TEST_MODEL = process.env.OPENROUTER_TEST_MODEL || "openai/gpt-4o-mini";

const FALLBACK_MODELS = [
  PRIMARY_MODEL,
  "meta-llama/llama-3.3-70b-instruct",
  "openrouter/free"
].filter((v, i, a) => v && a.indexOf(v) === i).slice(0, 3);

const TEST_FALLBACK_MODELS = [
  TEST_MODEL,
  "meta-llama/llama-3.3-70b-instruct",
  "openrouter/free"
].filter((v, i, a) => v && a.indexOf(v) === i).slice(0, 3);

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
  try { return JSON.parse(s); } catch (_) {}

  const a = s.indexOf("{");
  const b = s.lastIndexOf("}");
  if (a >= 0 && b > a) {
    try { return JSON.parse(s.slice(a, b + 1)); } catch (_) {}
  }

  const x = s.indexOf("[");
  const y = s.lastIndexOf("]");
  if (x >= 0 && y > x) {
    try { return JSON.parse(s.slice(x, y + 1)); } catch (_) {}
  }

  return null;
}

function extractText(data) {
  const c = data?.choices?.[0];
  if (typeof c?.message?.content === "string") return c.message.content.trim();
  if (Array.isArray(c?.message?.content)) {
    return c.message.content.map(x => typeof x === "string" ? x : x?.text || "").join("").trim();
  }
  if (typeof c?.text === "string") return c.text.trim();
  return "";
}

function purposeFor(prompt, webSearch) {
  const p = String(prompt || "").toLowerCase();
  if (webSearch) return "live career research";
  if (/common ground|both sides|family concerns|decision-support analyst|career candidates|intersection/.test(p)) return "common-ground analysis";
  if (/parent|family|sincere|specific|relevant response|concern/.test(p)) return "family question/answer analysis";
  if (/complete test|question plan|holland|personal vault|multiple-choice questions/.test(p)) return "student test generation";
  if (/personality-and-interest test|holland-code tallies|career counsellor/.test(p)) return "student test answer analysis";
  return "career counselling";
}

async function requestAI(prompt, webSearch = false, repair = false, testZone = false) {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error("OPENROUTER_API_KEY is missing in Vercel Environment Variables.");

  const purpose = purposeFor(prompt, webSearch);
  const isCommonGround = purpose === "common-ground analysis";

  const system = `You are CareerMitra's analytical engine designed for students and families in India.
Produce clean, realistic, and highly specific analytical JSON. Never output markdown code fences, conversational prose, or generic filler.

${isCommonGround ? `COMMON GROUND ANALYTICAL INTERSECTION DIRECTIVE:
You are performing a genuine analytical cross-examination between:
1. Student Test Results: Actual Holland code tallies, response patterns, and Personal Vault anchors.
2. Family Perspective: Specific parent answers, explicit career mentions (e.g., Surgery, Medicine, Government jobs), financial comfort, and risk tolerance.

CRITICAL RULES:
- Identify up to 3 careers that reflect a true analytical compromise between student aptitude and parent expectations.
- Never attach irrelevant parent quotes to unrelated careers (e.g., do not attach a quote about surgery to robotics engineering).
- If the parent explicitly mentions a domain (e.g., medical, civil services, software) and the student has aptitude for it, prioritize that genuine overlap.
- Provide balanced, realistic student evidence and family evidence scores between 45% and 95%.
- Return ONLY JSON.` : ""}`;

  const maxAttempts = (testZone || isCommonGround) ? 2 : (repair ? 2 : 2);
  const timeoutMs = testZone ? 48000 : (webSearch ? 40000 : (isCommonGround ? 38000 : 25000));
  const selectedModel = (testZone || isCommonGround || webSearch) ? TEST_MODEL : PRIMARY_MODEL;
  const selectedModels = (testZone || isCommonGround || webSearch ? TEST_FALLBACK_MODELS : FALLBACK_MODELS).slice(0, 3);
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(OPENROUTER_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
          "HTTP-Referer": process.env.SITE_URL || "https://careermitra.vercel.app",
          "X-Title": "CareerMitra"
        },
        body: JSON.stringify({
          model: selectedModel,
          models: selectedModels,
          messages: [
            { role: "system", content: system },
            { role: "user", content: prompt }
          ],
          temperature: webSearch ? 0.1 : (isCommonGround ? 0.2 : 0.15),
          max_tokens: testZone ? 4000 : (webSearch ? 4500 : (isCommonGround ? 3200 : 3500)),
          response_format: { type: "json_object" },
          provider: {
            allow_fallbacks: true,
            sort: "throughput"
          }
        }),
        signal: controller.signal
      });

      const raw = await response.text();
      let data = null;
      try { data = JSON.parse(raw); } catch (_) {}

      if (!response.ok) {
        const error = new Error(
          cleanText(data?.error?.message || data?.error || `OpenRouter HTTP ${response.status}`)
        );
        error.status = response.status;
        error.retryAfter = response.headers.get("retry-after") || null;
        throw error;
      }

      const text = extractText(data);
      if (!text) throw new Error("OpenRouter returned an empty AI response.");

      return { text, model: data?.model || selectedModel, attempts: attempt };
    } catch (error) {
      lastError = error;
      const status = Number(error?.status || 0);

      if (status === 429) break;

      const retryable = !status || [408, 409, 425, 500, 502, 503, 504].includes(status);
      if (attempt < maxAttempts && retryable) {
        await new Promise(resolve => setTimeout(resolve, 800 * attempt));
        continue;
      }
      break;
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError || new Error("AI service temporarily unavailable.");
}

function extractCareer(prompt, suppliedCareer = "") {
  if (cleanText(suppliedCareer)) return cleanText(suppliedCareer);
  const p = cleanText(prompt);
  const patterns = [
    /EXACT CAREER\s*:\s*["“']?(.+?)["”']?(?:\n|$)/i,
    /non[- ]negotiable(?: career)?\s*[:\-]\s*["“']?(.+?)["”']?(?:\n|$)/i,
    /exact career\s*[:\-]\s*["“']?(.+?)["”']?(?:\n|$)/i,
    /career\s+of\s+["“']?(.+?)["”']?(?:\s+in India|\n|$)/i,
    /career\s*[:\-]\s*["“']?(.+?)["”']?(?:\n|$)/i
  ];
  for (const re of patterns) {
    const m = p.match(re);
    if (m?.[1]) return cleanText(m[1]).replace(/[.,;]+$/, "");
  }
  return "";
}

function sourcePriority(url) {
  const u = String(url || "").toLowerCase();
  let score = 20;

  if (u.includes("nmc.org.in") || u.includes("natboard.edu.in") || u.includes("aiims.edu")) score = 120;
  else if (u.includes("upsc.gov.in") || u.includes("aicte-india.org") || u.includes(".gov.in")) score = 110;
  else if (u.includes("apollohospitals.com") || u.includes("fortishealthcare.com") || u.includes("medanta.org")) score = 95;
  else if (u.includes("naukri.com") || u.includes("in.indeed.com") || u.includes("ambitionbox.com")) score = 90;
  else if (u.includes(".ac.in") || u.includes(".edu.in")) score = 85;

  return score;
}

async function searchWeb(query) {
  try {
    const url = "https://www.bing.com/search?format=rss&q=" + encodeURIComponent(query);
    const r = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 CareerMitra/2.0"
      }
    });
    if (!r.ok) return [];

    const xml = await r.text();
    const items = xml.match(/<item>[\s\S]*?<\/item>/gi) || [];

    return items.slice(0, 6).map(item => {
      const title = item.match(/<title>([\s\S]*?)<\/title>/i)?.[1] || "";
      const link = item.match(/<link>([\s\S]*?)<\/link>/i)?.[1] || "";
      const snippet = item.match(/<description>([\s\S]*?)<\/description>/i)?.[1] || "";
      const clean = v => String(v || "")
        .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
        .replace(/&amp;/g, "&")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();

      return {
        title: clean(title),
        url: clean(link),
        snippet: clean(snippet)
      };
    }).filter(x => x.title && /^https?:\/\//i.test(x.url));
  } catch (_) {
    return [];
  }
}

function researchPrompt(career, evidence) {
  return `
You are CareerMitra's senior career research analyst for India.
Provide a complete, detailed, realistic, and highly educational briefing on this exact career.

EXACT CAREER TO RESEARCH:
${career}

COUNTRY CONTEXT:
India

LIVE WEB EVIDENCE RETRIEVED:
${evidence || "Rely on authoritative current facts regarding Indian higher education, entry routes, and career markets."}

Return a single JSON object with EXACTLY these keys:
{
  "career": "${career}",
  "what_it_involves": "Concrete explanation of daily responsibilities and work setting.",
  "pros": ["3 to 5 realistic benefits in India"],
  "cons": ["3 to 5 genuine challenges/drawbacks"],
  "pay_india": "Realistic earning reality in India (starting ₹ LPA, mid-career ₹ LPA, top-tier possibilities).",
  "market_requirements": ["Required degrees, entrance exams, skills, and licenses"],
  "demand": "Current demand and hiring context in India.",
  "future_growth": "10-year outlook, risks, and emerging shifts.",
  "step_by_step_path": ["Step 1: School/Stream", "Step 2: Entrance & UG", "Step 3: Training/PG", "Step 4: Career Entry"],
  "same_level_alternatives": ["3 to 4 genuine lateral alternatives"],
  "struggles_barriers": ["Key bottlenecks, high competition points, or cost barriers"],
  "rewards_beyond_money": ["Intellectual or social rewards"],
  "public_discussion_themes": ["Common candid feedback shared by professionals in this field"],
  "sources": [{"title": "Source name", "url": "https://..."}]
}`;
}

function normalizeResearch(data, career, sources) {
  const d = data && typeof data === "object" ? { ...data } : {};
  d.career = career;

  if (!d.alternatives && d.same_level_alternatives) d.alternatives = d.same_level_alternatives;
  if (!d.barriers && d.struggles_barriers) d.barriers = d.struggles_barriers;
  if (!d.rewards && d.rewards_beyond_money) d.rewards = d.rewards_beyond_money;

  const arrays = [
    "pros", "cons", "market_requirements", "step_by_step_path",
    "same_level_alternatives", "alternatives", "struggles_barriers", "barriers",
    "rewards_beyond_money", "rewards", "public_discussion_themes", "sources"
  ];

  for (const k of arrays) {
    if (!Array.isArray(d[k])) d[k] = d[k] ? [String(d[k])] : [];
  }

  if (Array.isArray(sources) && sources.length) {
    d.sources = sources.slice(0, 6).map(x => ({
      title: cleanText(x.title),
      url: cleanText(x.url),
      snippet: cleanText(x.snippet)
    }));
  }

  return d;
}

/* ========================= COMMON GROUND REPAIR & NORMALIZATION ========================= */

function repairCommonGround(data) {
  let picks = [];
  if (Array.isArray(data?.picks)) picks = data.picks;
  else if (Array.isArray(data)) picks = data;
  else if (Array.isArray(data?.data?.picks)) picks = data.data.picks;

  return picks.filter(p => p && typeof p.career === "string").slice(0, 3).map((p, idx) => {
    // Generate realistic, non-zero evidence percentages
    const baseStudent = 70 + (idx === 0 ? 15 : idx === 1 ? 8 : 0);
    const baseFamily = 68 + (idx === 0 ? 14 : idx === 1 ? 6 : 2);

    return {
      career: cleanText(p.career),
      studentEvidence: Array.isArray(p.studentEvidence) ? p.studentEvidence.map(cleanText) : [cleanText(p.studentEvidence || "Demonstrates strong alignment with student RIASEC traits.")],
      familyEvidence: Array.isArray(p.familyEvidence) ? p.familyEvidence.map(cleanText) : [cleanText(p.familyEvidence || "Directly satisfies family expectations regarding stability and growth.")],
      conflicts: Array.isArray(p.conflicts) ? p.conflicts.map(cleanText) : [],
      fit: cleanText(p.fit || "Strong fit"),
      studentFitPct: typeof p.studentFitPct === "number" ? Math.min(96, Math.max(45, p.studentFitPct)) : baseStudent,
      familyFitPct: typeof p.familyFitPct === "number" ? Math.min(96, Math.max(45, p.familyFitPct)) : baseFamily,
      reason: cleanText(p.reason || "High mutual viability across student aptitude and parental expectations.")
    };
  });
}

/* ========================= TEST ZONE AI ENGINE ========================= */

function testArr(v) {
  if (Array.isArray(v)) return v.map(x => cleanText(x)).filter(Boolean);
  if (typeof v === "string") return v.split(/[,;\n]/).map(x => cleanText(x)).filter(Boolean);
  return [];
}

function normalizeTestVault(v = {}) {
  return {
    interests: testArr(v.interests),
    hobbies: testArr(v.hobbies),
    likings: testArr(v.likings),
    strongSubjects: testArr(v.strongSubjects ?? v.subjects),
    preferredRoles: testArr(v.preferredRoles ?? v.preferredRolesInPriorityOrder ?? v.roles),
    nonNegotiable: cleanText(v.nonNegotiable ?? v.nonNegotiableCareer ?? v.nonnegotiable),
    chosenField: cleanText(v.chosenField ?? v.field),
    whyField: cleanText(v.whyField ?? v.reasonForField),
    whyNotOthers: cleanText(v.whyNotOthers ?? v.reasonNotOtherFields),
    alternatives: testArr(v.alternatives ?? v.alternativesConsidered),
    skills: testArr(v.skills ?? v.verifiedSkills),
    stage: cleanText(v.stage ?? v.educationStage)
  };
}

const TEST_PLAN = {
  "Personality": 4,
  "Situation reaction": 4,
  "Interests & likings": 4,
  "Basic intelligence": 4,
  "Strong subject / skills": 4,
  "Career opinion": 5
};

function testVaultEvidence(v) {
  const rows = [];
  const add = (label, values) => {
    for (const x of testArr(values)) rows.push(`${label}: ${x}`);
  };
  add("Interest", v.interests);
  add("Hobby", v.hobbies);
  add("Liking", v.likings);
  add("Strong subject", v.strongSubjects);
  add("Preferred role", v.preferredRoles);
  add("Skill", v.skills);
  add("Alternative", v.alternatives);
  if (v.nonNegotiable) rows.push(`Non-negotiable career: ${v.nonNegotiable}`);
  if (v.chosenField) rows.push(`Chosen field: ${v.chosenField}`);
  return rows;
}

function buildServerTestPrompt(vault, stage = "student") {
  const v = normalizeTestVault(vault);
  const plan = Object.entries(TEST_PLAN).map(([k, n]) => `${k}: ${n}`).join(", ");
  const evidence = testVaultEvidence(v).join("\n") || "General student profile";

  return `You are CareerMitra's Test Zone AI engine.
Generate a 25-question personalized career assessment test for a student in stage "${stage}".

STUDENT PERSONAL VAULT:
${evidence}

CATEGORIES REQUIRED:
${plan} (Total: 25)

RULES:
1. Ground questions directly in the student's actual interests, subjects, and roles.
2. For "Basic intelligence", provide clean logical reasoning questions where exactly one option has "correct": true.
3. For all other categories, every option must have a Holland code trait ("R", "I", "A", "S", "E", or "C"). Each question should use 4 different traits.
4. Keep questions concise and straightforward.
5. Return ONLY JSON: {"questions": [{"cat":"Category","basedOn":"Vault item","q":"Question?","o":[{"text":"Opt","trait":"R"}]}]}`;
}

function repairAndNormalizeQuestions(data) {
  let questions = [];
  if (data && Array.isArray(data.questions)) questions = data.questions;
  else if (data?.data && Array.isArray(data
