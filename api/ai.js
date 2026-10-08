export const maxDuration = 60;

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

const PRIMARY_MODEL = process.env.OPENROUTER_MODEL || "openai/gpt-4o-mini";
const TEST_MODEL = process.env.OPENROUTER_TEST_MODEL || "openai/gpt-4o-mini";

const FALLBACK_MODELS = [
  PRIMARY_MODEL,
  "nvidia/nemotron-3.5-lightning:free",
  "openrouter/free"
].filter((v, i, a) => v && a.indexOf(v) === i).slice(0, 3);

const TEST_FALLBACK_MODELS = [
  TEST_MODEL,
  "nvidia/nemotron-3.5-lightning:free",
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
  if (/common ground|both sides|family concerns|decision-support analyst/.test(p)) return "common-ground analysis";
  if (/parent|family|sincere|specific|relevant response|concern/.test(p)) return "family question/answer analysis";
  if (/complete test|question plan|holland|personal vault|multiple-choice questions/.test(p)) return "student test generation";
  if (/personality-and-interest test|holland-code tallies|career counsellor/.test(p)) return "student test answer analysis";
  return "career counselling";
}

async function requestAI(prompt, webSearch = false, repair = false, testZone = false) {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error("OPENROUTER_API_KEY is missing in Vercel Environment Variables.");

  const purpose = purposeFor(prompt, webSearch);
  const system = `You are CareerMitra's ${purpose} engine.

Your job is to produce an accurate, objective, high-quality result for Indian students and families.
Return ONLY valid JSON. Never return markdown, prose outside JSON, or code fences.

GENERAL RULES:
- Ground everything in current Indian educational and job market realities.
- For live career research, research the EXACT requested career; never substitute or broaden it.
- Keep pay and salary ranges realistic, providing experience/tier context (Tier 1 vs Tier 2/3, freshers vs seniors).
- When live research web snippets are provided, cite and use only verifiable details from them.
- Do NOT hallucinate absurd, outdated, or extreme claims.`;

  const maxAttempts = testZone ? 1 : (repair ? 2 : 2);
  const timeoutMs = testZone ? 48000 : (webSearch ? 25000 : 15000);
  const selectedModel = testZone ? TEST_MODEL : PRIMARY_MODEL;
  const selectedModels = (testZone ? TEST_FALLBACK_MODELS : FALLBACK_MODELS).slice(0, 3);
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
          temperature: webSearch ? 0.1 : 0.2,
          max_tokens: testZone ? 4000 : 4000,
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
        await new Promise(resolve => setTimeout(resolve, 800));
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
    /career\s*[:\-]\s*["“']?(.+?)["”']?(?:\n|$)/i,
    /career\s+of\s+["“']?(.+?)["”']?(?:\s+in India|\n|$)/i
  ];
  for (const re of patterns) {
    const m = p.match(re);
    if (m?.[1]) return cleanText(m[1]).replace(/[.,;]+$/, "");
  }
  return "";
}

async function searchWeb(query) {
  try {
    const url = "https://html.duckduckgo.com/html/?q=" + encodeURIComponent(query);
    const r = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
      }
    });
    if (!r.ok) return [];

    const html = await r.text();
    const results = [];
    const snippetRegex = /<a class="result__snippet[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gi;
    const titleRegex = /<a class="result__url[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gi;
    
    // Quick regex match for results
    const rawMatches = html.match(/<div class="result__body">[\s\S]*?<\/div>/gi) || [];
    for (const block of rawMatches.slice(0, 8)) {
      const titleMatch = block.match(/<a class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/i);
      const snipMatch = block.match(/<a class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i);
      if (titleMatch && titleMatch[1]) {
        let link = titleMatch[1];
        if (link.includes("uddg=")) {
          const rawUrl = link.split("uddg=")[1]?.split("&")[0];
          if (rawUrl) link = decodeURIComponent(rawUrl);
        }
        const clean = v => String(v || "").replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").trim();
        results.push({
          title: clean(titleMatch[2]),
          url: clean(link),
          snippet: clean(snipMatch ? snipMatch[1] : "")
        });
      }
    }
    return results.filter(x => /^https?:\/\//i.test(x.url));
  } catch (_) {
    return [];
  }
}

function researchPrompt(career, evidence) {
  return `You are CareerMitra's senior career research analyst specializing in the Indian job and education market.

EXACT CAREER TO RESEARCH:
${career}

COUNTRY CONTEXT: India

EVIDENCE RETRIEVED FROM SEARCH:
${evidence || "Rely on authoritative and established market facts in India."}

Return ONLY valid JSON matching this exact structure:
{
  "career": "${career}",
  "what_it_involves": "Accurate day-to-day description of what the role actually does in India.",
  "pros": ["Major realistic advantage 1", "Major realistic advantage 2", "Major realistic advantage 3"],
  "cons": ["Major genuine trade-off or challenge 1", "Challenge 2"],
  "pay_india": "Realistic fresher, mid-level, and senior salary ranges in India (in LPA) with clear employer/tier context.",
  "market_requirements": ["Required degree", "Key technical/domain skills", "Licenses or certifications if any"],
  "demand": "Current realistic market hiring outlook in India.",
  "future_growth": "5 to 10 year outlook, automation impact, and emerging trends.",
  "step_by_step_path": ["Stage 1: School/Foundations", "Stage 2: Undergraduate/Degree", "Stage 3: Entry into industry", "Stage 4: Specialization/Growth"],
  "same_level_alternatives": ["Alternative career 1", "Alternative career 2"],
  "struggles_barriers": ["Key barrier to entry in India"],
  "rewards_beyond_money": ["Intellectual or social satisfaction"],
  "public_discussion_themes": ["Common discussions among practitioners regarding work-life balance and learning curve"],
  "sources": [{"title": "Source name", "url": "https://..."}]
}`;
}

function normalizeResearch(data, career, sources) {
  const d = data && typeof data === "object" ? { ...data } : {};
  d.career = career;
  if (!d.what_it_involves) d.what_it_involves = `The ${career} role involves applying specialized knowledge to solve domain-specific problems.`;
  if (!Array.isArray(d.pros)) d.pros = ["High professional scope", "Transferable skills"];
  if (!Array.isArray(d.cons)) d.cons = ["Demanding learning curve", "Competitive entry"];
  if (!d.pay_india) d.pay_india = "Competitive market rates based on experience and tier of organization.";
  if (!Array.isArray(d.market_requirements)) d.market_requirements = ["Relevant bachelor's degree", "Industry skills"];
  if (!d.demand) d.demand = "Steady market demand for qualified professionals.";
  if (!d.future_growth) d.future_growth = "Positive growth driven by industry modernization.";
  if (!Array.isArray(d.step_by_step_path)) d.step_by_step_path = ["Complete foundational studies", "Acquire degree", "Build portfolio & enter industry"];
  if (!Array.isArray(d.same_level_alternatives)) d.same_level_alternatives = [];
  if (!Array.isArray(d.struggles_barriers)) d.struggles_barriers = [];
  if (!Array.isArray(d.rewards_beyond_money)) d.rewards_beyond_money = [];
  if (!Array.isArray(d.public_discussion_themes)) d.public_discussion_themes = [];
  
  if (Array.isArray(sources) && sources.length) {
    d.sources = sources.slice(0, 6).map(s => ({
      title: s.title || "Reference",
      url: s.url,
      snippet: s.snippet || ""
    }));
  } else if (!Array.isArray(d.sources)) {
    d.sources = [];
  }
  return d;
}

/* ================= TEST ZONE NORMALIZER ================= */
const TEST_PLAN = {
  "Personality": 4,
  "Situation reaction": 4,
  "Interests & likings": 4,
  "Basic intelligence": 4,
  "Strong subject / skills": 4,
  "Career opinion": 5
};

function normalizeTestVault(v = {}) {
  const cleanArr = a => Array.isArray(a) ? a.map(cleanText).filter(Boolean) : (typeof a === "string" ? a.split(/[,;\n]/).map(cleanText).filter(Boolean) : []);
  return {
    interests: cleanArr(v.interests),
    hobbies: cleanArr(v.hobbies),
    likings: cleanArr(v.likings),
    strongSubjects: cleanArr(v.strongSubjects ?? v.subjects),
    preferredRoles: cleanArr(v.preferredRoles ?? v.preferredRolesInPriorityOrder ?? v.roles),
    nonNegotiable: cleanText(v.nonNegotiable ?? v.nonNegotiableCareer ?? v.nonnegotiable),
    chosenField: cleanText(v.chosenField ?? v.field),
    whyField: cleanText(v.whyField ?? v.reasonForField),
    whyNotOthers: cleanText(v.whyNotOthers ?? v.reasonNotOtherFields),
    alternatives: cleanArr(v.alternatives ?? v.alternativesConsidered),
    skills: cleanArr(v.skills ?? v.verifiedSkills),
    stage: cleanText(v.stage ?? v.educationStage)
  };
}

function repairAndNormalizeQuestions(data) {
  let questions = [];
  if (data && Array.isArray(data.questions)) questions = data.questions;
  else if (data?.data && Array.isArray(data.data.questions)) questions = data.data.questions;
  else if (Array.isArray(data)) questions = data;

  if (!questions.length) return null;

  const validCategories = Object.keys(TEST_PLAN);
  const traitPool = ["R", "I", "A", "S", "E", "C"];
  const sanitized = [];

  for (let i = 0; i < questions.length; i++) {
    const rawQ = questions[i];
    if (!rawQ || typeof rawQ !== "object" || !cleanText(rawQ.q)) continue;

    const cat = validCategories.includes(rawQ.cat) ? rawQ.cat : validCategories[i % validCategories.length];
    let options = Array.isArray(rawQ.o) ? rawQ.o.filter(Boolean) : [];
    if (options.length < 2) continue;

    while (options.length < 4) {
      options.push({ text: `Alternative choice ${options.length + 1}` });
    }
    options = options.slice(0, 4);

    const isFactual = cat === "Basic intelligence" || options.some(o => o && "correct" in o);

    if (isFactual) {
      const hasTrue = options.some(o => o.correct === true);
      options = options.map((opt, idx) => ({
        text: cleanText(opt.text || `Option ${idx + 1}`),
        correct: hasTrue ? Boolean(opt.correct) : idx === 0
      }));
      if (!options.some(o => o.correct)) options[0].correct = true;
    } else {
      const usedTraits = new Set();
      options = options.map((opt, idx) => {
        let trait = String(opt.trait || "").toUpperCase();
        if (!traitPool.includes(trait) || usedTraits.has(trait)) {
          trait = traitPool.find(t => !usedTraits.has(t)) || traitPool[idx % traitPool.length];
        }
        usedTraits.add(trait);
        return { text: cleanText(opt.text || `Option ${idx + 1}`), trait };
      });
    }

    sanitized.push({
      id: rawQ.id || `q_${sanitized.length + 1}`,
      cat,
      basedOn: cleanText(rawQ.basedOn) || "Personal Vault",
      q: cleanText(rawQ.q),
      o: options
    });
  }

  return sanitized.length >= 18 ? sanitized : null;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const prompt = cleanText(body.prompt);
    const webSearch = body.webSearch === true;
    const suppliedCareer = cleanText(body.career);

    if (!prompt) {
      return res.status(400).json({ ok: false, error: "Missing prompt" });
    }

    const requestedPurpose = cleanText(body.purpose);
    const isTest = requestedPurpose === "student test generation" || body.testZone === true;

    // 1. TEST ZONE ROUTE
    if (isTest) {
      const vault = normalizeTestVault(body.vault || {});
      const stage = cleanText(body.stage || vault.stage || "student");
      const planStr = Object.entries(TEST_PLAN).map(([k, n]) => `${k}: ${n}`).join(", ");
      
      const testPrompt = `You are CareerMitra's Test Zone engine. Create a 25-question career test for a student in stage "${stage}".
PERSONAL VAULT DATA:
${JSON.stringify(vault)}
CATEGORIES: ${planStr}
RULES:
- Return ONLY JSON matching: {"questions":[{"cat":"Category","basedOn":"Vault item","q":"Question","o":[{"text":"Opt","trait":"R"}]}]}
- For Basic intelligence, use options with {"text":"Opt","correct":true/false}.`;

      const ai = await requestAI(testPrompt, false, false, true);
      const parsed = parseJSON(ai.text);
      const sanitized = repairAndNormalizeQuestions(parsed);

      if (!sanitized) {
        return res.status(503).json({ ok: false, error: "Failed to generate valid test questions." });
      }

      return res.status(200).json({
        ok: true,
        ai: true,
        data: { questions: sanitized },
        serverValidated: true
      });
    }

    // 2. LIVE WEB RESEARCH ROUTE
    if (webSearch) {
      const career = suppliedCareer || extractCareer(prompt);
      if (!career) {
        return res.status(400).json({ ok: false, error: "Could not determine exact career to research." });
      }

      const searchQuery = `"${career}" career in India scope salary qualification`;
      const sources = await searchWeb(searchQuery);
      const evidence = sources.map((s, i) => `[${i + 1}] ${s.title}: ${s.snippet} (${s.url})`).join("\n");

      const aiRes = await requestAI(researchPrompt(career, evidence), true);
      const parsed = parseJSON(aiRes.text);
      const normalized = normalizeResearch(parsed, career, sources);

      return res.status(200).json({
        ok: true,
        ai: true,
        data: normalized,
        sources: normalized.sources
      });
    }

    // 3. COMMON GROUND & GENERAL AI ROUTE
    const generalAI = await requestAI(prompt, false);
    const parsedData = parseJSON(generalAI.text) || { text: generalAI.text };

    return res.status(200).json({
      ok: true,
      ai: true,
      data: parsedData
    });

  } catch (error) {
    console.error("API error:", error);
    return res.status(503).json({
      ok: false,
      error: cleanText(error?.message || "AI service temporarily unavailable.")
    });
  }
}
