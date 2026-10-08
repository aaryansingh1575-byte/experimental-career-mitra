export const maxDuration = 60;

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

const uniq = (arr) => arr.filter((v, i, a) => v && a.indexOf(v) === i);

const PRIMARY_MODEL =
  process.env.OPENROUTER_MODEL || "nvidia/nemotron-3-ultra-550b-a55b:free";

// OpenRouter allows a maximum of 3 models in the `models` array.
const FALLBACK_MODELS = uniq([
  PRIMARY_MODEL,
  "nvidia/nemotron-3.5-lightning:free",
  "openrouter/free"
]).slice(0, 3);

// Test Zone uses the FAST model first (the 550B model is too slow for
// structured 25-question output and caused the 50s abort).
const TEST_PRIMARY_MODEL =
  process.env.OPENROUTER_TEST_MODEL || "nvidia/nemotron-3.5-lightning:free";

const TEST_MODELS = uniq([
  TEST_PRIMARY_MODEL,
  PRIMARY_MODEL,
  "openrouter/free"
]).slice(0, 3);


/* =========================================================
   BASIC HELPERS
   ========================================================= */

function cleanText(v) {
  return String(v ?? "").replace(/\u0000/g, "").trim();
}

function stripFence(text) {
  return String(text || "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/^\s*```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();
}

/* Returns the first balanced {...} or [...] block (string-aware), or "" */
function extractBalanced(s, open, close) {
  const start = s.indexOf(open);
  if (start < 0) return "";
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return "";
}

function parseJSON(text) {
  if (!text) return null;
  const s = stripFence(text);

  try { return JSON.parse(s); } catch (_) {}

  // Prefer whichever bracket appears first
  const iObj = s.indexOf("{");
  const iArr = s.indexOf("[");
  const order = (iArr >= 0 && (iObj < 0 || iArr < iObj))
    ? [["[", "]"], ["{", "}"]]
    : [["{", "}"], ["[", "]"]];

  for (const [o, c] of order) {
    const block = extractBalanced(s, o, c);
    if (block) {
      try { return JSON.parse(block); } catch (_) {}
    }
  }
  return null;
}

function extractText(data) {
  const c = data?.choices?.[0];
  if (typeof c?.message?.content === "string") return c.message.content.trim();
  if (Array.isArray(c?.message?.content)) {
    return c.message.content
      .map((x) => (typeof x === "string" ? x : x?.text || ""))
      .join("")
      .trim();
  }
  if (typeof c?.text === "string") return c.text.trim();
  return "";
}

function wrapAbort(error, timeoutMs) {
  if (error?.name === "AbortError" || /aborted/i.test(error?.message || "")) {
    const e = new Error(
      `AI request timed out after ${Math.round(timeoutMs / 1000)}s`
    );
    e.timedOut = true;
    return e;
  }
  return error;
}


/* =========================================================
   PURPOSE DETECTION
   ========================================================= */

function purposeFor(prompt, webSearch) {
  const p = String(prompt || "").toLowerCase();
  if (webSearch) return "live career research";
  if (/common ground|both sides|family concerns|student test analysis|decision-support analyst/.test(p))
    return "common-ground analysis";
  if (/parent|family|sincere|specific|relevant response|concern/.test(p))
    return "family question/answer analysis";
  if (/complete test|question plan|holland|personal vault|multiple-choice questions/.test(p))
    return "student test generation";
  if (/personality-and-interest test|holland-code tallies|career counsellor/.test(p))
    return "student test answer analysis";
  return "career counselling";
}


/* =========================================================
   OPENROUTER REQUEST (career research / analysis routes)
   ========================================================= */

async function requestAI(prompt, webSearch = false, repair = false) {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) {
    throw new Error("OPENROUTER_API_KEY is missing in Vercel Environment Variables.");
  }

  const purpose = purposeFor(prompt, webSearch);

  const system = `
You are CareerMitra's ${purpose} engine.

Your job is to produce a HIGH-QUALITY, useful result for a real student.

Return ONLY valid JSON.
Never return markdown.
Never return prose outside JSON.
Never return code fences.

GENERAL RULES:

- Use the supplied student/family information exactly; never invent personal facts.
- For live career research, keep the EXACT career requested.
- Do not replace a specialization with a broader career.
- Separate verified facts, reasonable professional context, and uncertainty.
- Never invent a source URL, salary number, qualification, regulation, statistic, or demand claim.
- If evidence is weak for a field, return a useful cautious statement rather than an empty generic sentence.
- Prefer India-specific evidence because CareerMitra is built for Indian students.
- Write concrete, student-friendly information, not filler.

${webSearch ? `
LIVE RESEARCH QUALITY:

- Use the web evidence supplied in the user message.
- Cross-check important claims across multiple sources when possible.
- Prefer official Indian authorities, medical boards, government sources, universities, established Indian hospitals and reputable India job portals.
- Do not treat one job listing as proof of national demand or salary.
- Explain salary as a range/context when evidence supports it; otherwise state what is and is not verified.
- For medical careers, distinguish undergraduate medical education, postgraduate specialty training, registration and optional/advanced subspecialty training.
- For a specialist/subspecialist career, explain the actual pathway instead of giving a generic career paragraph.
` : ""}

${repair ? `
THIS IS A RECOVERY PASS.

A previous model response was incomplete or malformed.

Rebuild the requested JSON from the original evidence.

Do not shorten it merely to finish quickly.
` : ""}
`;

  const maxAttempts = 2;
  const timeoutMs = webSearch ? 18000 : 12000;
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
          model: PRIMARY_MODEL,
          models: FALLBACK_MODELS,
          messages: [
            { role: "system", content: system },
            { role: "user", content: prompt }
          ],
          temperature: webSearch ? 0.05 : 0.15,
          max_tokens: webSearch ? 6500 : 6000,
          provider: { allow_fallbacks: true, sort: "throughput" }
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
        error.providerCode = data?.error?.metadata?.provider_code || null;
        throw error;
      }

      const text = extractText(data);
      if (!text) throw new Error("OpenRouter returned an empty AI response.");

      return { text, model: data?.model || PRIMARY_MODEL, attempts: attempt };

    } catch (err) {
      const error = wrapAbort(err, timeoutMs);
      lastError = error;
      const status = Number(error?.status || 0);

      if (status === 429) break; // don't hammer a rate-limited provider

      const retryable =
        !status || [408, 409, 425, 500, 502, 503, 504].includes(status);

      if (attempt < maxAttempts && retryable) {
        await new Promise((r) => setTimeout(r, Math.min(1200, 350 * attempt)));
        continue;
      }
      break;
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError || new Error("AI service temporarily unavailable.");
}


/* =========================================================
   CAREER EXTRACTION
   ========================================================= */

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


/* =========================================================
   SOURCE PRIORITY
   ========================================================= */

const SOURCE_SCORES = [
  ["nmc.org.in", 120], ["natboard.edu.in", 118], ["nbe.edu.in", 118],
  ["mcc.nic.in", 116], ["aiimsexams.ac.in", 114], ["aiims.edu", 112],
  [".gov.in", 100], ["apollohospitals.com", 95], ["fortishealthcare.com", 93],
  ["maxhealthcare.in", 93], ["medanta.org", 93], [".ac.in", 90],
  ["in.indeed.com", 88], ["naukri.com", 82], ["linkedin.com", 70], ["who.int", 65]
];

function sourcePriority(url) {
  const u = String(url || "").toLowerCase();
  for (const [needle, score] of SOURCE_SCORES) {
    if (u.includes(needle)) return score;
  }
  return 20;
}


/* =========================================================
   WEB SEARCH
   ========================================================= */

async function searchWeb(query) {
  try {
    const url = "https://www.bing.com/search?format=rss&q=" + encodeURIComponent(query);
    const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 CareerMitra/1.0" } });
    if (!r.ok) return [];

    const xml = await r.text();
    const items = xml.match(/<item>[\s\S]*?<\/item>/gi) || [];

    const clean = (v) =>
      String(v || "")
        .replace(/<!\[CDATA\[|\]\]>/g, "")
        .replace(/&amp;/g, "&")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/<[^>]+>/g, " ")
        .trim();

    return items
      .slice(0, 10)
      .map((item) => ({
        title: clean(item.match(/<title>([\s\S]*?)<\/title>/i)?.[1]),
        url: clean(item.match(/<link>([\s\S]*?)<\/link>/i)?.[1]),
        snippet: clean(item.match(/<description>([\s\S]*?)<\/description>/i)?.[1])
      }))
      .filter((x) => x.title && /^https?:\/\//i.test(x.url));
  } catch (_) {
    return [];
  }
}


/* =========================================================
   RESEARCH PROMPT
   ========================================================= */

function researchPrompt(career, evidence) {
  return `
You are CareerMitra's senior India-focused career research analyst.

EXACT CAREER TO RESEARCH:
${career}

DO NOT CHANGE THIS CAREER.

If the input says a specialization,
research that specialization exactly.

COUNTRY:
India

LIVE WEB EVIDENCE:
${evidence || "No usable live source was retrieved."}

Return ONLY one valid JSON object using exactly these keys:

{
  "career":"exact career name",
  "what_it_involves":"clear day-to-day explanation",
  "pros":["..."],
  "cons":["..."],
  "pay_india":"current India earning picture with experience/location/employer context",
  "market_requirements":["..."],
  "demand":"current India demand with careful evidence-based context",
  "future_growth":"future outlook, opportunities and risks",
  "step_by_step_path":["..."],
  "academic_education":["..."],
  "vocational_diploma":["..."],
  "certifications":["..."],
  "job_ready_skills":["..."],
  "alternatives":["..."],
  "barriers":["..."],
  "rewards":["..."],
  "public_discussion_themes":["..."],
  "student_fit":"only discuss fit if student data was actually supplied; otherwise say that student-specific fit needs the student's data",
  "family_concerns_addressed":["..."],
  "sources":[
    {
      "title":"...",
      "url":"...",
      "why_relevant":"..."
    }
  ]
}

QUALITY REQUIREMENTS:

1. EXACT CAREER:
Do not substitute a nearby career.

2. INDIA FIRST:
Prioritize NMC, NBEMS/NBME, MCC, AIIMS,
government sources, Indian medical institutions,
established Indian hospitals and reputable
India job sources.

3. MEDICAL PATHWAY:
Where applicable, clearly separate MBBS,
registration, postgraduate specialty training,
and advanced fellowship/subspecialty training.

4. PAY:
Never invent a precise salary.

5. DEMAND:
Do not call a career "high demand"
merely because jobs exist.

6. MARKET REQUIREMENTS:
Give actual qualifications, skills,
registration/licensing, experience and
employer expectations.

7. PATH:
Give a practical sequence a student
can follow.

8. ALTERNATIVES:
Give genuinely comparable alternatives.

9. PUBLIC DISCUSSION:
Summarize recurring discussion themes only.

10. SOURCES:
Only use URLs present in the supplied evidence.

11. COMPLETENESS:
Do not leave major fields empty.

12. NO FILLER.

13. JSON ONLY.
`;
}


/* =========================================================
   NORMALIZE RESEARCH
   ========================================================= */

function normalizeResearch(data, career, sources) {
  const d = data && typeof data === "object" && !Array.isArray(data) ? { ...data } : {};
  d.career = career;

  const aliases = {
    what_it_involves: ["role_description", "description"],
    pay_india: ["earning_reality_india", "salary"],
    market_requirements: ["requirements", "skills"],
    future_growth: ["growth_future", "future"],
    step_by_step_path: ["career_path", "path"],
    alternatives: ["same_level_alternatives"],
    barriers: ["struggles_barriers"],
    rewards: ["rewards_beyond_money"],
    public_discussion_themes: ["anecdotal_reviews", "public_discussion"],
    family_concerns_addressed: ["family_concerns"]
  };

  for (const [key, list] of Object.entries(aliases)) {
    if (d[key] == null || d[key] === "") {
      for (const a of list) {
        if (d[a] != null && d[a] !== "") { d[key] = d[a]; break; }
      }
    }
  }

  const arrays = [
    "pros", "cons", "market_requirements", "step_by_step_path",
    "academic_education", "vocational_diploma", "certifications",
    "job_ready_skills", "alternatives", "barriers", "rewards",
    "public_discussion_themes", "family_concerns_addressed", "sources"
  ];

  for (const k of arrays) {
    if (!Array.isArray(d[k])) d[k] = d[k] ? [String(d[k])] : [];
  }

  if (Array.isArray(sources) && sources.length) {
    d.sources = sources.map((x) => ({
      title: cleanText(x.title),
      url: cleanText(x.url),
      snippet: cleanText(x.snippet),
      why_relevant: "Live source retrieved for this career research."
    }));
  }

  if (!d.what_it_involves) {
    d.what_it_involves = `The ${career} role involves applying relevant knowledge and practical skills to solve problems and deliver useful outcomes.`;
  }
  if (!d.pay_india) d.pay_india = "Current India salary could not be reliably verified from the retrieved sources.";
  if (!d.demand) d.demand = "Current demand could not be reliably verified from the retrieved sources.";
  if (!d.future_growth) d.future_growth = "Future growth could not be reliably verified from the retrieved sources.";

  return d;
}


/* =========================================================
   WEB FALLBACK RESEARCH
   ========================================================= */

function webFallbackResearch(career, sources) {
  const usable = sources.slice(0, 12);

  const sourceList = usable.map((x) => ({
    title: x.title,
    url: x.url,
    snippet: x.snippet,
    why_relevant: "Retrieved as live evidence for this exact career in India."
  }));

  const text = usable.map((x) => `${x.title} ${x.snippet}`).join(" ");

  const medical =
    /surgeon|doctor|physician|orthopedic|orthopaedic|cardio|neuro|radiolog|dermatolog|anesthes|anaesthes|patholog|pediatric|paediatric|oncolog|dentist/i.test(career);
  const spine = /spine|spinal/i.test(career);

  const path = medical
    ? [
        "Complete the required undergraduate medical education pathway in India (typically MBBS for a medical specialist career).",
        "Complete the applicable compulsory registration/internship requirements under the current Indian regulatory framework.",
        "Enter the relevant postgraduate specialty pathway through the currently applicable entrance and counselling process.",
        spine
          ? "After orthopaedic specialty training, build advanced spine expertise through appropriate supervised training/fellowship where applicable."
          : "Build supervised specialist clinical and procedural experience.",
        "Continue professional development, evidence-based practice and any applicable registration/credential requirements."
      ]
    : [
        `Build the academic foundation required for ${career}.`,
        "Complete the relevant higher education or professional training pathway.",
        "Build practical skills through projects, supervised work or internships where applicable.",
        "Add relevant certifications only when they are valued for the target role.",
        "Gain experience and continue skill development as the market changes."
      ];

  const education = medical
    ? [
        "Medical undergraduate education is the foundation for the specialist pathway.",
        "Postgraduate specialty training is normally required for specialist medical practice.",
        spine
          ? "Advanced spine-focused training may be pursued after the core orthopaedic pathway; exact requirements vary by institution and should be checked against current rules."
          : "The exact specialty qualification should be verified against current NMC/NBEMS and institution-specific requirements."
      ]
    : [
        "The required academic qualification depends on the exact role and employer.",
        "Current course, university and employer requirements should be checked before choosing a programme."
      ];

  const requirements = usable
    .slice(0, 8)
    .map((x) => `${x.title}${x.snippet ? ` — ${x.snippet}` : ""}`);

  const hasSalaryEvidence = /salary|lakh|lpa|₹|rs\.?\s?\d|inr/i.test(text);
  const hasTrainingEvidence = /mbbs|ms |dnb|fellowship|registration|nmc|nbems|residency/i.test(text);

  return normalizeResearch(
    {
      career,
      what_it_involves: medical
        ? `${career} is a specialist medical career involving patient assessment, diagnosis, treatment planning, procedures/surgery where applicable, follow-up and continued professional learning. The exact scope depends on the specialist's training and practice setting.`
        : `${career} involves applying the knowledge and practical skills specific to the role, working with relevant tools or systems, solving real problems and delivering outcomes for an employer or client.`,

      pros: medical
        ? [
            "High level of specialised professional responsibility.",
            "Potential to make a direct impact on patient outcomes.",
            "Scope to build deep expertise and, depending on the career, teaching/research or private-practice opportunities."
          ]
        : [
            "Opportunity to develop specialised expertise.",
            "Potential for multiple employer or industry pathways as experience grows.",
            "Scope for continued learning and progression."
          ],

      cons: medical
        ? [
            "Long and demanding training pathway.",
            "High responsibility and the need for continuous skill development.",
            "Workload, location, employer and practice setting can strongly affect lifestyle."
          ]
        : [
            "Competition and entry requirements vary by employer.",
            "Skills need to be updated as the field changes.",
            "Early-career outcomes can vary significantly by location and employer."
          ],

      pay_india: hasSalaryEvidence
        ? "The live results contain salary/earning references, but they should be interpreted by experience, city, employer and practice type. Exact figures are not asserted here without a reliable cross-source salary dataset."
        : "No sufficiently reliable current India salary range was established from the retrieved sources; salary varies substantially by experience, location, employer and practice type.",

      market_requirements: requirements,

      demand: usable.length
        ? `Live India search results were found for ${career}. They show current activity around the career, but search-result volume alone is not a national demand statistic. Demand should be interpreted with location, employer, experience and specialization in mind.`
        : `No usable live India sources were retrieved for ${career}.`,

      future_growth: medical
        ? "The long-term outlook depends on population healthcare needs, specialist capacity, technology, referral patterns and the balance between public and private healthcare. Current growth should be treated as an evidence-based judgement rather than a guaranteed outcome."
        : "Future growth depends on industry demand, technology, employer needs and the ability to keep skills current.",

      step_by_step_path: path,
      academic_education: education,

      vocational_diploma: medical
        ? []
        : ["Diploma/vocational routes may be relevant only if they are explicitly accepted for the target role."],

      certifications: medical
        ? [
            "Current registration and specialist qualification requirements should be verified with the applicable Indian authority.",
            hasTrainingEvidence
              ? "The retrieved sources contain training/qualification references; verify the exact current pathway before making an education decision."
              : "No specific certification claim is made because the retrieved evidence was insufficient."
          ]
        : ["Choose certifications that are explicitly relevant to the target job rather than collecting certificates without practical experience."],

      job_ready_skills: medical
        ? [
            "Clinical assessment and decision-making",
            "Relevant procedural/surgical skills under appropriate supervision",
            "Patient and family communication",
            "Imaging/diagnostic interpretation where relevant",
            "Evidence-based practice",
            "Teamwork and multidisciplinary coordination"
          ]
        : [
            "Role-specific technical skills",
            "Communication",
            "Problem solving",
            "Practical project/work evidence",
            "Interview and workplace skills"
          ],

      alternatives: medical
        ? [
            "Related specialist pathways within the same broad medical field",
            "Academic/teaching or research pathways after specialist training",
            "Hospital-based clinical roles with adjacent expertise"
          ]
        : [],

      barriers: medical
        ? [
            "Long education and training timeline",
            "Competitive entry into specialist training",
            "High professional responsibility",
            "Need for continuous learning and credential maintenance"
          ]
        : [
            "Competition for entry-level roles",
            "Need for demonstrable practical skills",
            "Changing technology and employer expectations"
          ],

      rewards: medical
        ? [
            "Specialist expertise",
            "Potential to improve patient outcomes",
            "Professional growth and teaching/research opportunities",
            "Potential to develop a specialised practice"
          ]
        : [
            "Expertise and professional growth",
            "Potential for progression into higher-responsibility roles",
            "Opportunity to work across different organisations or industries"
          ],

      public_discussion_themes: [],
      student_fit:
        "Student-specific fit cannot be safely inferred from career research alone; CareerMitra should combine this research with the student's Test Zone and Personal Vault data.",
      family_concerns_addressed: [],
      sources: sourceList
    },
    career,
    sourceList
  );
}


/* =========================================================
   RESEARCH VALIDATION
   ========================================================= */

function researchNeedsRepair(data) {
  if (!data || typeof data !== "object") return true;

  const required = [
    "career", "what_it_involves", "pros", "cons", "pay_india",
    "market_requirements", "demand", "future_growth", "step_by_step_path",
    "academic_education", "job_ready_skills", "alternatives", "barriers",
    "rewards", "sources"
  ];

  const missing = required.filter(
    (k) =>
      data[k] == null ||
      data[k] === "" ||
      (Array.isArray(data[k]) && data[k].length === 0)
  );

  return missing.length >= 4;
}


/* =========================================================
   TEST ZONE — VAULT HELPERS
   ========================================================= */

function testArr(v) {
  if (Array.isArray(v)) return v.map((x) => cleanText(x)).filter(Boolean);
  if (typeof v === "string") {
    return v.split(/[,;\n]/).map((x) => cleanText(x)).filter(Boolean);
  }
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

/*
 * The 25 questions are generated in 3 PARALLEL batches instead of one huge
 * request. One 25-question request was too slow (hit the 50s abort) and
 * truncated/garbled output was producing "Missing questions array".
 */
const TEST_BATCHES = [
  ["Personality", "Situation reaction"],
  ["Interests & likings", "Strong subject / skills"],
  ["Basic intelligence", "Career opinion"]
];

const HOLLAND = new Set(["R", "I", "A", "S", "E", "C"]);

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
  if (v.whyField) rows.push(`Reason for field: ${v.whyField}`);
  if (v.whyNotOthers) rows.push(`Reason not other fields: ${v.whyNotOthers}`);

  return rows;
}


/* =========================================================
   TEST ZONE — PROMPT
   ========================================================= */

const TEST_SYSTEM = `You are CareerMitra's Test Zone question generator.
Return ONLY one valid JSON object. No markdown, no code fences, no explanations,
no reasoning text before or after the JSON. Keep every question under 35 words
and every option under 18 words.`;

function buildBatchPrompt(vault, stage, cats) {
  const v = normalizeTestVault(vault);
  const evidence = testVaultEvidence(v).join("\n") || "No detailed Vault evidence was supplied.";

  const plan = cats.map((c) => `${c}: exactly ${TEST_PLAN[c]}`).join("\n");
  const total = cats.reduce((s, c) => s + TEST_PLAN[c], 0);
  const hasIQ = cats.includes("Basic intelligence");

  return `
Create part of a personalized self-discovery test for ONE student.
Do not use a generic question bank.

STUDENT STAGE:
${stage}

PERSONAL VAULT:
${JSON.stringify(v, null, 2)}

EXACT PERSONAL EVIDENCE:
${evidence}

QUESTIONS TO WRITE IN THIS RESPONSE (use the category names EXACTLY as written):
${plan}

TOTAL IN THIS RESPONSE: ${total}

Rules:
- Use the student's actual Vault as the source of personalization.
- Do not invent interests, skills, subjects, roles or experiences.
- Interests & likings: use real interests/hobbies/likings in at least 3 of 4 questions when available.
- Strong subject / skills: use real subjects/skills in at least 3 of 4 when available.
- Career opinion: use the student's field, roles, alternatives, non-negotiable career or reasons across the 5 questions.
- Personality and Situation reaction measure natural preferences, not sell a career.
- Basic intelligence is independent of the student's career and has exactly one correct answer.
- Never make the student's non-negotiable career the 'correct' answer.
- Every question has exactly 4 options.
- NON-factual categories: each of the 4 options has a DIFFERENT Holland code from R,I,A,S,E,C in "trait". Do NOT add "correct".
${hasIQ ? `- Basic intelligence: each option has "correct" true/false (exactly one true). Do NOT add "trait".\n` : ""}- Options must be realistic, comparable, neutral and similarly attractive.
- No moral winner, no obvious smart/lazy option, no duplicate questions.
- "basedOn" must state the actual Vault evidence used${hasIQ ? ", or 'General reasoning' only for Basic intelligence" : ""}.

Return ONLY this JSON shape:

{
  "questions": [
    {
      "cat": "Category name",
      "basedOn": "actual Vault evidence",
      "q": "question",
      "o": [
        { "text": "option", "trait": "R" },
        { "text": "option", "trait": "I" },
        { "text": "option", "trait": "A" },
        { "text": "option", "trait": "S" }
      ]
    }
  ]
}
${hasIQ ? `
Basic intelligence option shape: { "text": "option", "correct": false }
` : ""}
The "questions" array MUST contain exactly ${total} items.
`;
}


/* =========================================================
   TEST ZONE — RESPONSE PARSING / NORMALIZATION
   ========================================================= */

const looksQ = (x) =>
  x && typeof x === "object" &&
  (x.q || x.question) &&
  (Array.isArray(x.o) || Array.isArray(x.options));

/* Accepts {questions:[...]}, a bare array, {data:{questions}}, etc. */
function pullQuestions(d, depth = 0) {
  if (!d || depth > 3) return [];
  if (Array.isArray(d)) return d.filter(looksQ);
  if (typeof d === "object") {
    for (const k of ["questions", "test", "items", "data", "result"]) {
      const r = pullQuestions(d[k], depth + 1);
      if (r.length) return r;
    }
    for (const v of Object.values(d)) {
      if (Array.isArray(v) && v.some(looksQ)) return v.filter(looksQ);
    }
  }
  return [];
}

/* If the model output was cut off mid-JSON, recover every COMPLETE question object */
function salvageQuestionObjects(text) {
  const s = stripFence(text);
  let i = s.search(/"questions"\s*:\s*\[/);
  i = i >= 0 ? s.indexOf("[", i) : s.indexOf("[");
  if (i < 0) return [];

  const out = [];
  let depth = 0, inStr = false, esc = false, start = -1;

  for (let k = i + 1; k < s.length; k++) {
    const ch = s[k];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === "{") { if (depth === 0) start = k; depth++; }
    else if (ch === "}") {
      depth--;
      if (depth === 0 && start >= 0) {
        try {
          const obj = JSON.parse(s.slice(start, k + 1));
          if (looksQ(obj)) out.push(obj);
        } catch (_) {}
        start = -1;
      }
      if (depth < 0) break;
    } else if (ch === "]" && depth === 0) break;
  }
  return out;
}

function matchCategory(raw, allowed) {
  const c = cleanText(raw).toLowerCase();
  const exact = allowed.find((a) => a.toLowerCase() === c);
  if (exact) return exact;
  const loose = allowed.find((a) => {
    const al = a.toLowerCase();
    return c && (al.startsWith(c) || c.startsWith(al.split(/[ \/&]/)[0]));
  });
  if (loose) return loose;
  return allowed.length === 1 ? allowed[0] : cleanText(raw);
}

function normalizeQuestion(raw, allowedCats) {
  const cat = matchCategory(raw.cat ?? raw.category, allowedCats);
  const isIQ = cat === "Basic intelligence";

  const opts = (raw.o || raw.options || []).map((x) =>
    typeof x === "string" ? { text: x } : x || {}
  );

  let o = opts.map((x) => {
    const out = { text: cleanText(x.text ?? x.option ?? x.label) };
    const t = cleanText(x.trait ?? x.code ?? x.holland).toUpperCase().slice(0, 1);
    if (isIQ) {
      out.correct = x.correct === true || x.correct === "true";
    } else if (t) {
      out.trait = t;
    }
    return out;
  });

  if (isIQ && o.length && !opts.some((x) => x.correct !== undefined)) {
    // model forgot "correct" entirely — leave all false so validation rejects it
    o = o.map((x) => ({ ...x, correct: false }));
  }

  return {
    cat,
    basedOn: cleanText(raw.basedOn ?? raw.based_on ?? raw.evidence),
    q: cleanText(raw.q ?? raw.question),
    o
  };
}


/* =========================================================
   TEST ZONE — VALIDATION
   ========================================================= */

const normQ = (s) =>
  cleanText(s).toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();

function makeGroundedChecker(vault) {
  const evidence = testVaultEvidence(normalizeTestVault(vault)).map((x) => x.toLowerCase());

  return (q) => {
    if (q.cat === "Basic intelligence") return true;
    if (!evidence.length) return true;

    const hay = `${q.basedOn || ""} ${q.q || ""}`.toLowerCase();

    return evidence.some((src) => {
      const words = src
        .replace(/[^a-z0-9 ]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length >= 4);
      if (!words.length) return false;
      return words.some((w) => hay.includes(w)) || hay.includes(src);
    });
  };
}

function validateQuestion(q, n, grounded) {
  const errors = [];

  if (!q || typeof q !== "object") return [`Q${n}: invalid object`];

  if (!Object.prototype.hasOwnProperty.call(TEST_PLAN, q.cat)) {
    errors.push(`Q${n}: invalid category "${q.cat}"`);
  }
  if (!cleanText(q.q)) errors.push(`Q${n}: missing question`);
  if (!cleanText(q.basedOn)) errors.push(`Q${n}: missing basedOn`);

  if (!Array.isArray(q.o) || q.o.length !== 4) {
    errors.push(`Q${n}: must have exactly 4 options`);
    return errors;
  }

  const texts = q.o.map((x) => cleanText(x?.text));
  if (texts.some((x) => !x)) errors.push(`Q${n}: empty option`);
  if (new Set(texts.map((x) => x.toLowerCase())).size !== 4) {
    errors.push(`Q${n}: duplicate options`);
  }

  const factual = q.cat === "Basic intelligence";

  if (factual) {
    const correct = q.o.filter((x) => x?.correct === true).length;
    if (correct !== 1) errors.push(`Q${n}: factual question must have exactly one correct option`);
  } else {
    const traits = q.o.map((x) => x?.trait);
    if (traits.some((x) => !HOLLAND.has(x))) errors.push(`Q${n}: invalid Holland trait`);
    if (new Set(traits).size !== 4) errors.push(`Q${n}: options need four different traits`);
  }

  if (grounded && !grounded(q)) errors.push(`Q${n}: not grounded in supplied Personal Vault`);

  return errors;
}

function findDuplicates(questions) {
  const errors = [];
  const seen = questions.map((q) => normQ(q?.q));
  for (let i = 0; i < seen.length; i++) {
    for (let j = 0; j < i; j++) {
      const a = seen[j], b = seen[i];
      if (a && b && (a === b || a.includes(b) || b.includes(a))) {
        errors.push(`Q${i + 1}: duplicate/similar question`);
        break;
      }
    }
  }
  return errors;
}

function validateCounts(questions, cats) {
  const errors = [];
  const counts = {};
  for (const q of questions) counts[q.cat] = (counts[q.cat] || 0) + 1;
  for (const c of cats) {
    if ((counts[c] || 0) !== TEST_PLAN[c]) {
      errors.push(`${c}: expected ${TEST_PLAN[c]}, got ${counts[c] || 0}`);
    }
  }
  return errors;
}

function validateBatch(questions, cats, vault) {
  const grounded = makeGroundedChecker(vault);
  const errors = [];

  if (!questions.length) return { ok: false, errors: ["Missing questions array"] };

  questions.forEach((q, i) => errors.push(...validateQuestion(q, i + 1, grounded)));
  errors.push(...findDuplicates(questions));
  errors.push(...validateCounts(questions, cats));

  return { ok: errors.length === 0, errors };
}

/* Kept for compatibility: validates a full 25-question payload */
function validateServerTest(data, vault) {
  const questions = pullQuestions(data);
  if (!questions.length) return { ok: false, errors: ["Missing questions array"] };

  const errors = [];
  if (questions.length !== 25) errors.push(`Expected 25 questions, got ${questions.length}`);

  const grounded = makeGroundedChecker(vault);
  questions.forEach((q, i) => errors.push(...validateQuestion(q, i + 1, grounded)));
  errors.push(...findDuplicates(questions));
  errors.push(...validateCounts(questions, Object.keys(TEST_PLAN)));

  return { ok: errors.length === 0, errors };
}


/* =========================================================
   TEST ZONE — MODEL CALL (fast, single attempt per call)
   ========================================================= */

async function callTestModel(prompt, timeoutMs) {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) {
    throw new Error("OPENROUTER_API_KEY is missing in Vercel Environment Variables.");
  }

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
        model: TEST_PRIMARY_MODEL,
        models: TEST_MODELS,
        messages: [
          { role: "system", content: TEST_SYSTEM },
          { role: "user", content: prompt }
        ],
        temperature: 0.3,
        max_tokens: 4000,
        provider: { allow_fallbacks: true, sort: "throughput" }
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

    return {
      text,
      model: data?.model || TEST_PRIMARY_MODEL,
      finishReason: data?.choices?.[0]?.finish_reason || null
    };
  } catch (err) {
    throw wrapAbort(err, timeoutMs);
  } finally {
    clearTimeout(timer);
  }
}

async function runBatch(vault, stage, cats, deadline) {
  const prompt = buildBatchPrompt(vault, stage, cats);
  let lastErr = null;

  for (let attempt = 1; attempt <= 2; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining < 8000) break; // not enough time for another try

    try {
      const ai = await callTestModel(prompt, Math.min(38000, remaining - 1500));

      let raw = pullQuestions(parseJSON(ai.text));
      if (!raw.length) raw = salvageQuestionObjects(ai.text);

      const questions = raw.map((q) => normalizeQuestion(q, cats));
      const check = validateBatch(questions, cats, vault);

      if (check.ok) return { questions, model: ai.model, attempts: attempt };

      const e = new Error("AI generated an invalid Test Zone payload.");
      e.testValidationFailed = true;
      e.validationErrors = check.errors.map((x) => `[${cats.join(" + ")}] ${x}`);
      lastErr = e;
    } catch (e) {
      lastErr = e;
      if (Number(e?.status) === 429) break; // rate limited — retrying won't help
    }
  }

  throw lastErr || new Error("Test Zone batch failed.");
}


/* =========================================================
   TEST ZONE — GENERATOR
   ========================================================= */

async function generateServerTest(vault, stage) {
  // Stay safely inside Vercel's 60s maxDuration
  const deadline = Date.now() + 54000;

  const results = await Promise.allSettled(
    TEST_BATCHES.map((cats) => runBatch(vault, stage, cats, deadline))
  );

  const failed = results.filter((r) => r.status === "rejected");

  if (failed.length) {
    const first = failed[0].reason || new Error("Test Zone AI temporarily unavailable.");
    const e = new Error(first.message || "Test Zone AI temporarily unavailable.");
    e.status = first.status;
    e.retryAfter = first.retryAfter || null;
    e.testValidationFailed = failed.some((f) => f.reason?.testValidationFailed);
    e.validationErrors = failed.flatMap((f) => f.reason?.validationErrors || []);
    e.testGenerationFailed = true;
    throw e;
  }

  // Assemble in the original TEST_PLAN order
  const byCat = {};
  let models = [];
  let attempts = 0;

  for (const r of results) {
    models.push(r.value.model);
    attempts = Math.max(attempts, r.value.attempts);
    for (const q of r.value.questions) (byCat[q.cat] ||= []).push(q);
  }

  const questions = Object.keys(TEST_PLAN).flatMap((c) => byCat[c] || []);
  const data = { questions };

  const check = validateServerTest(data, vault);
  if (!check.ok) {
    const e = new Error("AI generated an invalid Test Zone payload.");
    e.testValidationFailed = true;
    e.validationErrors = check.errors;
    throw e;
  }

  return { data, model: uniq(models).join(", "), attempts };
}


/* =========================================================
   MAIN VERCEL HANDLER
   ========================================================= */

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  try {
    const body =
      typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};

    const prompt = cleanText(body.prompt);
    const webSearch = body.webSearch === true;
    const suppliedCareer = cleanText(body.career);

    if (!prompt) {
      return res.status(400).json({ ok: false, error: "Missing prompt" });
    }

    /* ---------------- TEST ZONE ---------------- */

    const requestedPurpose = cleanText(body.purpose);
    const isTest = requestedPurpose === "student test generation" || body.testZone === true;

    if (isTest) {
      const vault = normalizeTestVault(body.vault || {});
      const hasVault = testVaultEvidence(vault).length > 0;

      if (!hasVault) {
        return res.status(400).json({
          ok: false,
          ai: false,
          fallbackUsed: false,
          aiFailed: true,
          fallbackAllowed: false,
          error: "Personal Vault data is required for Test Zone generation."
        });
      }

      try {
        const stage = cleanText(body.stage || vault.stage || "student");
        const generated = await generateServerTest(vault, stage);

        return res.status(200).json({
          ok: true,
          ai: true,
          fallbackUsed: false,
          data: generated.data,
          model: generated.model,
          attempts: generated.attempts,
          purpose: "student test generation"
        });
      } catch (error) {
        console.error("CareerMitra Test Zone AI failed", error, error?.validationErrors);

        return res.status(503).json({
          ok: false,
          ai: false,
          fallbackUsed: false,
          aiFailed: true,
          fallbackAllowed: true,
          testValidationFailed: Boolean(error?.testValidationFailed),
          validationErrors: error?.validationErrors || [],
          rateLimited: Number(error?.status) === 429,
          retryAfter: error?.retryAfter || null,
          error: cleanText(error?.message || "Test Zone AI temporarily unavailable.")
        });
      }
    }

    /* ---------------- NORMAL CAREER AI ---------------- */

    let finalPrompt = prompt;
    let sources = [];
    const career = suppliedCareer || extractCareer(prompt);

    if (webSearch) {
      if (!career) {
        return res.status(400).json({ ok: false, error: "Could not determine the exact career." });
      }

      const queries = [
        `"${career}" India qualifications education pathway site:nmc.org.in OR site:natboard.edu.in OR site:aiimsexams.ac.in`,
        `"${career}" India specialist training fellowship site:apollohospitals.com OR site:fortishealthcare.com OR site:medanta.org`,
        `"${career}" India jobs salary site:in.indeed.com OR site:naukri.com`,
        `"${career}" India demand jobs market`,
        `"${career}" India future growth technology healthcare`,
        `"${career}" India registration license requirements site:nmc.org.in OR site:gov.in`,
        `"${career}" India professional association fellowship`,
        `"${career}" India day to day responsibilities`,
        `"${career}" India hospital specialist department`,
        `"${career}" India training pathway career requirements`,
        `"${career}" India salary experience private hospital government hospital`,
        `${career} India current clinical practice patient treatment specialization`
      ];

      const groups = await Promise.all(queries.map(searchWeb));
      const seen = new Set();
      const badCountry =
        /melbourne|florida|australia|canada|united states|new york|california|uk orthopedic surgeon jobs/i;

      sources = groups
        .flat()
        .filter((x) => {
          if (!x.url || seen.has(x.url)) return false;
          const combined = `${x.title} ${x.snippet}`;
          if (badCountry.test(combined) && !/india|indian/i.test(combined)) return false;
          seen.add(x.url);
          return true;
        })
        .sort((a, b) => sourcePriority(b.url) - sourcePriority(a.url))
        .slice(0, 20);

      const evidence = sources
        .map((x, i) => `[SOURCE ${i + 1}]\nTITLE: ${x.title}\nURL: ${x.url}\nSNIPPET: ${x.snippet}`)
        .join("\n\n");

      finalPrompt = researchPrompt(career, evidence);
    }

    let ai;
    let usedFallback = false;

    try {
      ai = await requestAI(finalPrompt, webSearch);
    } catch (error) {
      console.error("CareerMitra AI request failed", error);

      if (webSearch && career && sources.length) {
        return res.status(200).json({
          ok: true,
          ai: false,
          fallbackUsed: true,
          aiFailed: true,
          rateLimited: Number(error?.status) === 429,
          retryAfter: error?.retryAfter || null,
          data: webFallbackResearch(career, sources),
          model: null,
          sources,
          warning: "Source-backed recovery was used only after the AI recovery chain failed."
        });
      }

      const status = Number(error?.status || 503);

      return res.status(status === 429 ? 429 : 503).json({
        ok: false,
        aiFailed: true,
        fallbackAllowed: true,
        rateLimited: status === 429,
        retryAfter: error?.retryAfter || null,
        error: cleanText(error?.message || "AI service temporarily unavailable.")
      });
    }

    let data = parseJSON(ai.text);

    if (webSearch) {
      if (!data || researchNeedsRepair(data)) {
        try {
          const repairPrompt = `${finalPrompt}

RECOVERY INSTRUCTION:

The previous response was incomplete or malformed.

Rebuild the COMPLETE JSON object now.

Every major section must contain useful
career-specific information grounded in
the supplied evidence.

Do not omit sections merely because
one source is weak.
`;
          const repaired = await requestAI(repairPrompt, true, true);
          const repairedData = parseJSON(repaired.text);

          if (repairedData && !researchNeedsRepair(repairedData)) {
            data = repairedData;
            ai = repaired;
          }
        } catch (repairError) {
          console.error("CareerMitra AI research repair failed", repairError);
        }
      }

      if (data) {
        data = normalizeResearch(data, career, sources);
      } else {
        data = webFallbackResearch(career, sources);
        usedFallback = true;
      }
    }

    return res.status(200).json({
      ok: true,
      ai: !usedFallback,
      fallbackUsed: usedFallback,
      data: data || ai.text,
      model: ai.model,
      attempts: ai.attempts,
      sources
    });
  } catch (error) {
    console.error("CareerMitra API ERROR", error);

    return res.status(503).json({
      ok: false,
      aiFailed: true,
      fallbackAllowed: true,
      error: cleanText(error?.message || "AI service temporarily unavailable.")
    });
  }
}
