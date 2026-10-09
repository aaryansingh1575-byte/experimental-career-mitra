export const maxDuration = 60;

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

// Use fast, reliable models with high reasoning throughput
const PRIMARY_MODEL = process.env.OPENROUTER_MODEL || "openai/gpt-4o-mini";
const TEST_MODEL = process.env.OPENROUTER_TEST_MODEL || "openai/gpt-4o-mini";

// OpenRouter strictly rejects models arrays with more than 3 items
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
  if (/common ground|both sides|family concerns|decision-support analyst|career candidates|strict common ground/i.test(p)) {
    return "common-ground analysis";
  }
  if (/neutral family-answer analyst|family-perspective question designer|sincere|specific|relevant response|concern/i.test(p)) {
    return "family question/answer analysis";
  }
  if (/complete test|question plan|holland|personal vault|multiple-choice questions|test zone designer/i.test(p)) {
    return "student test generation";
  }
  if (/personality-and-interest test|holland-code tallies|career counsellor|analysing your answers|student test answer analysis|careermitra’s neutral, humble and careful career-analysis/i.test(p)) {
    return "student test answer analysis";
  }
  return "career counselling";
}

async function requestAI(prompt, webSearch = false, repair = false, isTestGeneration = false) {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error("OPENROUTER_API_KEY is missing in Vercel Environment Variables.");

  const purpose = purposeFor(prompt, webSearch);
  const isCommonGround = purpose === "common-ground analysis";
  const isTestAnalysis = purpose === "student test answer analysis";

  const system = `You are CareerMitra's senior AI analytics and decision-support engine, designed for students and families in India.
Produce complete, highly realistic, practical, and factually accurate JSON output.
Never return markdown code fences, pleasantries, conversational filler, or ungrounded generalities.

GENERAL RULES:
- Ground all output in the provided prompt data. Never invent statistics, universities, accreditation, or salary numbers.
- Tailor all education pathways, recruitment processes, exams, and salaries to India (e.g., RRB ALP, NEET, JEE, UPSC, GATE, Indian corporate and PSU compensation in LPA).
- Provide high-utility analysis rather than generic filler.

${webSearch ? `LIVE RESEARCH REQUIREMENTS:
- Synthesize an accurate, real-world briefing for the exact career in India.
- Detail the real step-by-step path: required school stream, entrance exams, undergraduate degrees, professional training, licensing, and apprenticeships.
- Specify entry-level vs mid-career salary in INR (LPA or monthly scale).
- Discard irrelevant references that share the same name (such as entertainment apps, video game streamers, or songs).` : ""}

${isTestAnalysis ? `STUDENT TEST ANALYSIS & DETAILED CAREER ROADMAP:
- Analyze the student's actual responses, RIASEC tallies, and Personal Vault choices.
- In "rankedCareers", output up to 5 fully-realized career profiles reflecting the student's actual aptitude and non-negotiable career.
- FOR EACH CAREER in "rankedCareers", you MUST provide complete, detailed values:
  1. "name": exact career name.
  2. "fit": "Strong", "Moderate", or "Possible".
  3. "score": number between 0.50 and 0.95.
  4. "evidence": [2 to 4 concrete reasons tied directly to the student's choices].
  5. "watchouts": [1 to 3 realistic hurdles, competition factors, or physical/academic challenges].
  6. "pros": [3 to 4 genuine benefits in India].
  7. "cons": [3 to 4 genuine trade-offs or working condition realities in India].
  8. "mkt": realistic India earning and hiring picture (e.g., starting salary, senior salary, exam/hiring channels).
  9. "demand": realistic assessment of demand and competition in India.
  10. "future_growth": 10-year realistic outlook in India.
  11. "tradeoffs": [2 to 3 core trade-offs].
  12. "path": [sequential steps from current stage to professional entry].
  13. "academic": exact recognized degree/qualification in India.
  14. "vocational": recognized ITI, polytechnic diploma, or apprentice route.
  15. "certifications": [mandatory licenses, medical fitness standards, or credentials].
  16. "skills": [4 to 6 core practical and job-ready skills].
  17. "alternatives": [2 to 4 lateral options].
  18. "reason": concise summary of why this career fits the student.
- DO NOT leave pros, cons, mkt, or educational pathways empty.` : ""}

${isCommonGround ? `STRICT COMMON GROUND ANALYTICAL INTERSECTION:
- Compare the student's test results, vault, and RIASEC profile against the family's actual concerns and preferences.
- Select up to 3 careers that represent a genuine analytical compromise for BOTH sides.
- ACCURACY DIRECTIVE: Never attach irrelevant parent quotes to unrelated careers (e.g., do not attach quotes about surgery or medicine to defense, robotics, or engineering careers). Only include quotes that directly mention the field or state universal home constraints (such as zero loans, stability, or location).
- Provide balanced, realistic student evidence and family evidence fit percentages between 55% and 95%. NEVER return 0% or 1%.
- Clearly identify trade-offs or remaining conflicts.` : ""}`;

  const maxAttempts = (isTestGeneration || isCommonGround || isTestAnalysis) ? 2 : (repair ? 2 : 2);
  const timeoutMs = isTestGeneration ? 48000 : (webSearch ? 40000 : ((isCommonGround || isTestAnalysis) ? 42000 : 25000));
  const selectedModel = (isTestGeneration || isCommonGround || isTestAnalysis || webSearch) ? TEST_MODEL : PRIMARY_MODEL;
  const selectedModels = (isTestGeneration || isCommonGround || isTestAnalysis || webSearch ? TEST_FALLBACK_MODELS : FALLBACK_MODELS).slice(0, 3);
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
          max_tokens: isTestAnalysis ? 4500 : (isTestGeneration ? 4000 : (webSearch ? 4500 : 3500)),
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
  else if (u.includes("upsc.gov.in") || u.includes("indianrailways.gov.in") || u.includes("rrbcdg.gov.in") || u.includes("aicte-india.org") || u.includes(".gov.in")) score = 110;
  else if (u.includes("apollohospitals.com") || u.includes("fortishealthcare.com") || u.includes("medanta.org")) score = 95;
  else if (u.includes("naukri.com") || u.includes("in.indeed.com") || u.includes("ambitionbox.com")) score = 90;
  else if (u.includes(".ac.in") || u.includes(".edu.in")) score = 85;
  else if (u.includes("linkedin.com")) score = 70;

  return score;
}

async function searchWeb(query) {
  try {
    const url = "https://www.bing.com/search?format=rss&q=" + encodeURIComponent(query);
    const r = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 CareerMitra/2.0"
      }
    });
    if (!r.ok) return [];

    const xml = await r.text();
    const items = xml.match(/<item>[\s\S]*?<\/item>/gi) || [];

    return items.slice(0, 8).map(item => {
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
    }).filter(x => {
      const isNoise = /gaming|streamer|esports|song|lyrics|rapper|album|track/i.test(x.title + " " + x.snippet);
      return x.title && /^https?:\/\//i.test(x.url) && !isNoise;
    });
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
${evidence || "Rely on authoritative current facts regarding Indian higher education, official recruiting boards, and professional industries."}

Return a single JSON object with EXACTLY these keys:
{
  "career": "${career}",
  "what_it_involves": "Concrete explanation of daily responsibilities and work setting.",
  "pros": ["3 to 5 realistic benefits in India"],
  "cons": ["3 to 5 genuine challenges/drawbacks in India"],
  "pay_india": "Realistic earning reality in India (starting ₹ LPA/monthly, mid-career ₹ LPA, senior ₹ LPA, top possibilities).",
  "market_requirements": ["Required degrees, entrance exams, skills, and licenses in India"],
  "demand": "Current demand and hiring context in India.",
  "future_growth": "10-year outlook, risks, and emerging industry shifts.",
  "step_by_step_path": ["Step 1: School/Stream", "Step 2: Entrance & UG/Diploma", "Step 3: Training/Apprenticeship", "Step 4: Career Entry"],
  "same_level_alternatives": ["3 to 4 genuine lateral alternatives"],
  "struggles_barriers": ["Key bottlenecks, selection competition, or fitness/academic filters"],
  "rewards_beyond_money": ["Social impact, public service, or professional satisfaction"],
  "public_discussion_themes": ["Common candid feedback shared by professionals in this field in India"],
  "sources": [{"title": "Source name", "url": "https://..."}]
}

CRITICAL RULES:
- Do NOT return empty fields.
- Sources must use genuine URLs from the evidence or reputable standard reference sites.
- Return ONLY the JSON object.`;
}

function normalizeResearch(data, career, sources) {
  const d = data && typeof data === "object" ? { ...data } : {};
  d.career = career;

  // Harmonize keys expected by frontend
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

  if (!d.what_it_involves) d.what_it_involves = `The role of ${career} involves applying specialist knowledge, practical operational skills, and adhering to strict procedural guidelines in India.`;
  if (!d.pay_india) d.pay_india = "Starting packages range from ₹4-8 LPA in private corporate sectors or standard government pay levels (Level-2 to Level-7 7th CPC), scaling with seniority.";
  if (!d.demand) d.demand = "Steady demand across public notifications and private sectors in India, with high competition for certified openings.";
  if (!d.future_growth) d.future_growth = "Positive long-term trajectory driven by industry expansion, infrastructure upgrades, and technological adoption.";

  return d;
}

/* ========================= COMMON GROUND REPAIR ========================= */

function repairCommonGround(data) {
  let picks = [];
  if (Array.isArray(data?.picks)) picks = data.picks;
  else if (Array.isArray(data)) picks = data;
  else if (Array.isArray(data?.data?.picks)) picks = data.data.picks;

  return picks.filter(p => p && typeof p.career === "string").slice(0, 3).map((p, idx) => {
    const defaultStudent = idx === 0 ? 86 : idx === 1 ? 78 : 70;
    const defaultFamily = idx === 0 ? 84 : idx === 1 ? 76 : 68;

    const studentScore = typeof p.studentFitPct === "number"
      ? Math.max(55, Math.min(95, p.studentFitPct))
      : defaultStudent;

    const familyScore = typeof p.familyFitPct === "number"
      ? Math.max(55, Math.min(95, p.familyFitPct))
      : defaultFamily;

    return {
      career: cleanText(p.career),
      score: studentScore / 100,
      studentFitPct: studentScore,
      familyFitPct: familyScore,
      studentEvidence: Array.isArray(p.studentEvidence) ? p.studentEvidence.map(cleanText) : [cleanText(p.studentEvidence || "Demonstrates strong alignment with student RIASEC traits.")],
      familyEvidence: Array.isArray(p.familyEvidence) ? p.familyEvidence.map(cleanText) : [cleanText(p.familyEvidence || "Directly satisfies family expectations regarding stability and growth.")],
      conflicts: Array.isArray(p.conflicts) ? p.conflicts.map(cleanText) : [],
      fit: cleanText(p.fit || "Strong fit"),
      reason: cleanText(p.reason || "Solid analytical alignment between student aptitude and family perspective.")
    };
  });
}

/* ========================= STUDENT TEST ANALYSIS REPAIR ========================= */

function repairStudentAnalysis(data) {
  const d = data && typeof data === "object" ? { ...data } : {};

  if (Array.isArray(d.rankedCareers)) {
    d.rankedCareers = d.rankedCareers.map((c, i) => {
      const name = cleanText(c.name || c.career);
      const isMed = /doctor|surgeon|oncolog|mbbs|physician/i.test(name);
      const isRail = /loco|rail|train|pilot/i.test(name);

      return {
        name,
        fit: cleanText(c.fit || (i < 2 ? "Strong" : i < 4 ? "Moderate" : "Possible")),
        score: typeof c.score === "number" && c.score > 0 ? c.score : (0.92 - i * 0.08),
        evidence: Array.isArray(c.evidence) && c.evidence.length ? c.evidence.map(cleanText) : [
          `Your test choices demonstrated strong preference for practical, investigative, and structured problem-solving.`,
          `High compatibility with your stated interest in ${name}.`
        ],
        watchouts: Array.isArray(c.watchouts) && c.watchouts.length ? c.watchouts.map(cleanText) : [
          `Requires competitive exam preparation and focused domain training.`
        ],
        pros: Array.isArray(c.pros) && c.pros.length ? c.pros.map(cleanText) : (
          isRail ? [
            "Central Government job security with pension benefits and running allowances.",
            "High respect and critical operational responsibility within Indian Railways.",
            "Structured career progression from Assistant Loco Pilot to Loco Mail/Express."
          ] : isMed ? [
            "Highly respected noble profession with profound social impact.",
            "Consistent lifelong demand and stable earnings after specialty training.",
            "Diverse clinical, surgical, and teaching opportunities."
          ] : [
            "High market relevance and steady professional growth.",
            "Clear pathways to develop specialized technical mastery.",
            "Strong long-term demand across organized industry sectors in India."
          ]
        ),
        cons: Array.isArray(c.cons) && c.cons.length ? c.cons.map(cleanText) : (
          isRail ? [
            "Strict medical and vision fitness standards (A-1 category).",
            "Irregular shift duties and extended operational hours away from home.",
            "High concentration required with zero tolerance for procedural errors."
          ] : isMed ? [
            "Long study timeline (MBBS followed by competitive PG/Super-specialty).",
            "Demanding work hours, emergency calls, and high emotional stress.",
            "Intense competition for subsidized government medical seats."
          ] : [
            "Continuous upskilling required as tools and industry standards evolve.",
            "Demanding early-career workload with performance expectations."
          ]
        ),
        mkt: cleanText(c.mkt || c.market) || (
          isRail
            ? "Indian Railways 7th CPC Level-2 Pay Matrix (starting basic ₹19,900 + running allowances, gross ₹35,000–55,000/month; senior Loco Pilots earn ₹1–1.5+ Lakh/month)."
            : isMed
            ? "Resident doctors earn ₹60,000–1,10,000/month during PG; specialists in private/corporate hospitals earn ₹18–35+ LPA."
            : "Starting packages range ₹4–9 LPA, scaling to ₹18–30+ LPA with senior domain expertise."
        ),
        demand: cleanText(c.demand) || "Steady annual hiring through established exams, government notifications, or campus/lateral channels.",
        future_growth: cleanText(c.future_growth) || "Positive long-term scope driven by infrastructure expansion and modernization.",
        path: Array.isArray(c.path) && c.path.length ? c.path.map(cleanText) : (
          isRail ? [
            "Pass Class 10 with ITI in relevant trade or 3-year Diploma in Mechanical/Electrical/Automobile/ECE.",
            "Clear RRB ALP (Assistant Loco Pilot) CBT-1, CBT-2, and Computer Based Aptitude Test (CBAT).",
            "Pass strict A-1 Railway Medical Examination.",
            "Complete mandatory technical training at Railway Training Centres."
          ] : isMed ? [
            "Pass Class 12 with PCB and qualify NEET-UG.",
            "Complete 5.5 years MBBS including compulsory rotating internship.",
            "Register with NMC / State Medical Council.",
            "Clear NEET-PG / INI-CET for MD/MS specialty training."
          ] : [
            "Complete foundational higher secondary education.",
            "Earn a recognized professional degree or diploma.",
            "Build practical projects and gain internship experience.",
            "Enter entry-level role and pursue advanced certifications."
          ]
        ),
        academic: cleanText(c.academic) || (
          isRail ? "Class 10 + ITI / 3-Year Polytechnic Diploma in Mechanical, Electrical, Electronics, or Automobile Engineering."
          : isMed ? "MBBS degree recognized by National Medical Commission (NMC) followed by MD/MS/DNB."
          : "Relevant bachelor's degree (B.Tech, B.Sc, B.Com, or equivalent)."
        ),
        vocational: cleanText(c.vocational) || (
          isRail ? "NCVT/SCVT recognized ITI in Fitter, Electrician, Diesel Mechanic, Machinist, or Wireman trade."
          : isMed ? "Allied healthcare diploma or hospital clinical apprenticeship where applicable."
          : "Polytechnic Diploma in relevant engineering or technical branch."
        ),
        certifications: Array.isArray(c.certifications) && c.certifications.length ? c.certifications.map(cleanText) : (
          isRail ? ["RRB ALP Qualifying Certificate", "Railway Safety & Signaling Rules Certification", "A-1 Medical Vision Fitness"]
          : isMed ? ["NMC Medical Registration", "Basic Life Support (BLS)", "Advanced Cardiac Life Support (ACLS)"]
          : ["Industry-standard entry certifications", "Domain tool credentials"]
        ),
        skills: Array.isArray(c.skills) && c.skills.length ? c.skills.map(cleanText) : (
          isRail ? ["Railway signaling and speed control", "Locomotive instrument inspection", "Safety protocol adherence", "Emergency troubleshooting"]
          : isMed ? ["Clinical diagnosis", "Patient communication", "Medical record keeping", "Procedural accuracy"]
          : ["Analytical thinking", "Technical execution", "Problem solving", "Team coordination"]
        ),
        alternatives: Array.isArray(c.alternatives) && c.alternatives.length ? c.alternatives.map(cleanText) : (
          isRail ? ["Metro Train Operator", "Railway Section Engineer", "Industrial Plant Heavy Equipment Operator"]
          : isMed ? ["Medical Officer", "Clinical Research Scientist", "Hospital Administrator"]
          : ["Related technical or operational roles"]
        ),
        reason: cleanText(c.reason || `Direct match with student's aptitude pattern and career interests.`)
      };
    });
  }
  return d;
}

/* ========================= ROUTE HANDLER ========================= */

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const prompt = cleanText(body.prompt);
    const webSearch = body.webSearch === true;
    const suppliedCareer = cleanText(body.career);

    if (!prompt && !suppliedCareer) {
      return res.status(400).json({ ok: false, error: "Missing prompt or career target." });
    }

    const purpose = cleanText(body.purpose) || purposeFor(prompt, webSearch);
    const isTestGeneration = purpose === "student test generation";

    // 1. LIVE CAREER RESEARCH DISPATCH
    let finalPrompt = prompt;
    let sources = [];
    let career = suppliedCareer || extractCareer(prompt);

    if (webSearch) {
      if (!career) {
        return res.status(400).json({ ok: false, error: "Could not identify career name to research." });
      }

      // Targeted multi-angle Indian search queries that reject noise
      const queries = [
        `"${career}" qualifications eligibility education path site:gov.in OR site:nic.in OR site:ac.in`,
        `"${career}" recruitment notification exam salary India site:rrbcdg.gov.in OR site:upsc.gov.in OR site:nmc.org.in`,
        `"${career}" salary career structure India entry level experience naukri`
      ];

      const groups = await Promise.all(queries.map(searchWeb));
      const seen = new Set();
      sources = groups.flat().filter(x => {
        if (!x.url || seen.has(x.url)) return false;
        seen.add(x.url);
        return true;
      }).sort((a, b) => sourcePriority(b.url) - sourcePriority(a.url)).slice(0, 8);

      const evidence = sources.map((x, i) =>
        `[SOURCE ${i + 1}]: ${x.title}\nURL: ${x.url}\nINFO: ${x.snippet}`
      ).join("\n\n");

      finalPrompt = researchPrompt(career, evidence);
    }

    // 2. EXECUTE AI COMPLETION
    let ai;
    try {
      ai = await requestAI(finalPrompt, webSearch, false, isTestGeneration);
    } catch (error) {
      return res.status(503).json({
        ok: false,
        aiFailed: true,
        fallbackAllowed: true,
        error: cleanText(error?.message || "AI service temporarily unavailable.")
      });
    }

    let data = parseJSON(ai.text);

    // Normalize research payload
    if (webSearch) {
      data = normalizeResearch(data, career, sources);
    }

    // Normalize common-ground picks payload
    if (purpose === "common-ground analysis" && data) {
      const repairedPicks = repairCommonGround(data);
      if (repairedPicks.length) {
        data = { picks: repairedPicks };
      }
    }

    // Normalize student test analysis payload (for scorecard and options analyser)
    if (purpose === "student test answer analysis" && data) {
      data = repairStudentAnalysis(data);
    }

    return res.status(200).json({
      ok: true,
      ai: true,
      fallbackUsed: false,
      data: data || ai.text,
      model: ai.model,
      serverValidated: true,
      sources
    });

  } catch (error) {
    return res.status(500).json({
      ok: false,
      aiFailed: true,
      fallbackAllowed: true,
      error: cleanText(error?.message || "Internal server error.")
    });
  }
}
