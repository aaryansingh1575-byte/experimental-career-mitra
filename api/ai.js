export const maxDuration = 60;

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

// Keep the router configurable. openrouter/free is the safe default for demos.
const PRIMARY_MODEL = process.env.OPENROUTER_MODEL || "nvidia/nemotron-3-ultra-550b-a55b:free";
const TEST_MODEL = process.env.OPENROUTER_TEST_MODEL || "openai/gpt-4.1-mini";

const FALLBACK_MODELS = [
  PRIMARY_MODEL,
  "nvidia/nemotron-3.5-lightning:free",
  "openrouter/free"
].filter((v, i, a) => v && a.indexOf(v) === i);

const TEST_FALLBACK_MODELS = [
  TEST_MODEL,
  "nvidia/nemotron-3.5-lightning:free",
  "openrouter/free"
].filter((v, i, a) => v && a.indexOf(v) === i);

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
  if (/common ground|both sides|family concerns|student test analysis|decision-support analyst/.test(p)) return "common-ground analysis";
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

Your job is to produce a HIGH-QUALITY, useful result for a real student.
Return ONLY valid JSON. Never return markdown, prose outside JSON, or code fences.

GENERAL RULES:
- Use the supplied student/family information exactly; never invent personal facts.
- For live career research, keep the EXACT career requested.
- Do not replace a specialization with a broader career.
- Separate verified facts, reasonable professional context, and uncertainty.
- Never invent a source URL, salary number, qualification, regulation, statistic, or demand claim.
- If evidence is weak for a field, return a useful cautious statement rather than an empty generic sentence.
- Prefer India-specific evidence because CareerMitra is built for Indian students.
- Write concrete, student-friendly information, not filler.

${webSearch ? `LIVE RESEARCH QUALITY:
- Use the web evidence supplied in the user message.
- Cross-check important claims across multiple sources when possible.
- Prefer official Indian authorities, medical boards, government sources, universities, established Indian hospitals and reputable India job portals.
- Do not treat one job listing as proof of national demand or salary.
- Explain salary as a range/context when evidence supports it; otherwise state what is and is not verified.
- For medical careers, distinguish undergraduate medical education, postgraduate specialty training, registration and optional/advanced subspecialty training.
- For a specialist/subspecialist career, explain the actual pathway instead of giving a generic career paragraph.` : ""}

${repair ? `THIS IS A RECOVERY PASS. A previous model response was incomplete or malformed.
Rebuild the requested JSON from the original evidence. Do not shorten it merely to finish quickly.` : ""}`;

  // OpenRouter already performs model/provider failover. Repeating a 429 is
  // usually counterproductive because the account-level quota does not reset
  // during a few hundred milliseconds. Retry only transient infrastructure
  // failures, while allowing one full recovery request for malformed output.
  // Test Zone is intentionally a single request. A second long generation
  // inside the same Vercel invocation is what previously caused the ~50s abort.
  const maxAttempts = testZone ? 1 : (repair ? 2 : 2);
  const timeoutMs = testZone ? 45000 : (webSearch ? 18000 : 12000);
  const selectedModel = testZone ? TEST_MODEL : PRIMARY_MODEL;
  const selectedModels = testZone ? TEST_FALLBACK_MODELS : FALLBACK_MODELS;
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
          temperature: webSearch ? 0.05 : 0.15,
          max_tokens: testZone ? 5200 : (webSearch ? 6500 : 6000),
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
        error.providerCode = data?.error?.metadata?.provider_code || null;
        throw error;
      }

      const text = extractText(data);
      if (!text) throw new Error("OpenRouter returned an empty AI response.");

      return { text, model: data?.model || selectedModel, attempts: attempt };
    } catch (error) {
      lastError = error;
      const status = Number(error?.status || 0);

      // A 429 can mean the whole account has reached its free-model limit.
      // Do not hammer the same limit with more immediate retries.
      if (status === 429) break;

      const retryable = !status || [408, 409, 425, 500, 502, 503, 504].includes(status);
      if (attempt < maxAttempts && retryable) {
        const wait = Math.min(1200, 350 * attempt);
        await new Promise(resolve => setTimeout(resolve, wait));
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

  if (u.includes("nmc.org.in")) score = 120;
  else if (u.includes("natboard.edu.in")) score = 118;
  else if (u.includes("nbe.edu.in")) score = 118;
  else if (u.includes("mcc.nic.in")) score = 116;
  else if (u.includes("aiimsexams.ac.in")) score = 114;
  else if (u.includes("aiims.edu")) score = 112;
  else if (u.includes("apollohospitals.com")) score = 95;
  else if (u.includes("fortishealthcare.com")) score = 93;
  else if (u.includes("maxhealthcare.in")) score = 93;
  else if (u.includes("medanta.org")) score = 93;
  else if (u.includes("in.indeed.com")) score = 88;
  else if (u.includes("naukri.com")) score = 82;
  else if (u.includes("linkedin.com")) score = 70;
  else if (u.includes("who.int")) score = 65;
  else if (u.includes(".gov.in")) score = 100;
  else if (u.includes(".ac.in")) score = 90;

  return score;
}

async function searchWeb(query) {
  try {
    const url = "https://www.bing.com/search?format=rss&q=" + encodeURIComponent(query);
    const r = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 CareerMitra/1.0"
      }
    });
    if (!r.ok) return [];

    const xml = await r.text();
    const items = xml.match(/<item>[\s\S]*?<\/item>/gi) || [];

    return items.slice(0, 10).map(item => {
      const title = item.match(/<title>([\s\S]*?)<\/title>/i)?.[1] || "";
      const link = item.match(/<link>([\s\S]*?)<\/link>/i)?.[1] || "";
      const snippet = item.match(/<description>([\s\S]*?)<\/description>/i)?.[1] || "";
      const clean = v => String(v || "")
        .replace(/<!\[CDATA\[|\]\]>/g, "")
        .replace(/&amp;/g, "&")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/<[^>]+>/g, " ")
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
You are CareerMitra's senior India-focused career research analyst.

EXACT CAREER TO RESEARCH:
${career}

DO NOT CHANGE THIS CAREER.
If the input says a specialization, research that specialization exactly.

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
  "sources":[{"title":"...","url":"...","why_relevant":"..."}]
}

QUALITY REQUIREMENTS:
1. EXACT CAREER: Do not substitute a nearby career. For example, if the career is "orthopedic surgeon with spine speciality", keep spine specialization central throughout the answer.
2. INDIA FIRST: Prioritize NMC, NBEMS/NBME, MCC, AIIMS, government sources, Indian medical institutions, established Indian hospitals and reputable India job sources.
3. MEDICAL PATHWAY: Where applicable, clearly separate MBBS, registration, postgraduate specialty training, and advanced fellowship/subspecialty training. Do not imply that a fellowship is always legally mandatory unless a source supports that claim.
4. PAY: Never invent a precise salary. Use source-supported ranges or explain why a reliable range cannot be established. Mention experience, city, employer and private/public practice differences where relevant.
5. DEMAND: Do not call a career "high demand" merely because jobs exist. Explain the evidence and limitations.
6. MARKET REQUIREMENTS: Give actual qualifications, skills, registration/licensing, experience and employer expectations supported by evidence.
7. PATH: Give a practical sequence a student can follow. Include entrance/training milestones when supported.
8. ALTERNATIVES: Give genuinely comparable alternatives, not random lower-level jobs.
9. PUBLIC DISCUSSION: Summarize recurring discussion themes only. Do not present Reddit/forums as statistical evidence.
10. SOURCES: Only use URLs present in the supplied evidence. Never manufacture a URL.
11. COMPLETENESS: Do not leave the major fields empty just because one source is weak. Use reliable professional context for stable facts and clearly mark anything that could not be verified currently.
12. NO FILLER: Avoid sentences like "opportunities should be evaluated" unless the evidence genuinely cannot answer the field.
13. JSON ONLY. No markdown fences and no explanation outside JSON.
`;
}

function normalizeResearch(data, career, sources) {
  const d = data && typeof data === "object" ? { ...data } : {};
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
        if (d[a] != null && d[a] !== "") {
          d[key] = d[a];
          break;
        }
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

  // Never trust URLs invented by the model. The only source URLs exposed to the UI
  // are URLs actually retrieved by CareerMitra's live search.
  if (Array.isArray(sources) && sources.length) {
    d.sources = sources.map(x => ({
      title: cleanText(x.title),
      url: cleanText(x.url),
      snippet: cleanText(x.snippet),
      why_relevant: "Live source retrieved for this career research."
    }));
  } else if (!d.sources.length) {
    d.sources = [];
  }

  if (!d.what_it_involves) d.what_it_involves = `The ${career} role involves applying relevant knowledge and practical skills to solve problems and deliver useful outcomes.`;
  if (!d.pay_india) d.pay_india = "Current India salary could not be reliably verified from the retrieved sources.";
  if (!d.demand) d.demand = "Current demand could not be reliably verified from the retrieved sources.";
  if (!d.future_growth) d.future_growth = "Future growth could not be reliably verified from the retrieved sources.";

  return d;
}

function webFallbackResearch(career, sources) {
  const usable = sources.slice(0, 12);
  const sourceList = usable.map(x => ({
    title: x.title,
    url: x.url,
    snippet: x.snippet,
    why_relevant: "Retrieved as live evidence for this exact career in India."
  }));

  const text = usable.map(x => `${x.title} ${x.snippet}`).join(" ");
  const medical = /surgeon|doctor|physician|orthopedic|orthopaedic|cardio|neuro|radiolog|dermatolog|anesthes|anaesthes|patholog|pediatric|paediatric|oncolog|dentist/i.test(career);
  const spine = /spine|spinal/i.test(career);

  // This is deliberately a LAST-RESORT source-backed response. It should be
  // useful, but it must never pretend that it is AI-synthesized.
  const path = medical
    ? [
        "Complete the required undergraduate medical education pathway in India (typically MBBS for a medical specialist career).",
        "Complete the applicable compulsory registration/internship requirements under the current Indian regulatory framework.",
        "Enter the relevant postgraduate specialty pathway through the currently applicable entrance and counselling process.",
        spine ? "After orthopaedic specialty training, build advanced spine expertise through appropriate supervised training/fellowship where applicable." : "Build supervised specialist clinical and procedural experience.",
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
        spine ? "Advanced spine-focused training may be pursued after the core orthopaedic pathway; exact requirements vary by institution and should be checked against current rules." : "The exact specialty qualification should be verified against current NMC/NBEMS and institution-specific requirements."
      ]
    : [
        "The required academic qualification depends on the exact role and employer.",
        "Current course, university and employer requirements should be checked before choosing a programme."
      ];

  const requirements = usable.slice(0, 8).map(x =>
    `${x.title}${x.snippet ? ` — ${x.snippet}` : ""}`
  );

  const hasSalaryEvidence = /salary|lakh|lpa|₹|rs\.?\s?\d|inr/i.test(text);
  const hasTrainingEvidence = /mbbs|ms |dnb|fellowship|registration|nmc|nbems|residency/i.test(text);

  return normalizeResearch({
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
    vocational_diploma: medical ? [] : ["Diploma/vocational routes may be relevant only if they are explicitly accepted for the target role."],
    certifications: medical
      ? [
          "Current registration and specialist qualification requirements should be verified with the applicable Indian authority.",
          hasTrainingEvidence ? "The retrieved sources contain training/qualification references; verify the exact current pathway before making an education decision." : "No specific certification claim is made because the retrieved evidence was insufficient."
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
    student_fit: "Student-specific fit cannot be safely inferred from career research alone; CareerMitra should combine this research with the student's Test Zone and Personal Vault data.",
    family_concerns_addressed: [],
    sources: sourceList
  }, career, sourceList);
}

function researchNeedsRepair(data) {
  if (!data || typeof data !== "object") return true;
  const required = [
    "career",
    "what_it_involves",
    "pros",
    "cons",
    "pay_india",
    "market_requirements",
    "demand",
    "future_growth",
    "step_by_step_path",
    "academic_education",
    "job_ready_skills",
    "alternatives",
    "barriers",
    "rewards",
    "sources"
  ];
  const missing = required.filter(k => data[k] == null || data[k] === "" || (Array.isArray(data[k]) && data[k].length === 0));
  return missing.length >= 4;
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
  if (v.whyField) rows.push(`Reason for field: ${v.whyField}`);
  if (v.whyNotOthers) rows.push(`Reason not other fields: ${v.whyNotOthers}`);
  return rows;
}

function buildServerTestPrompt(vault, stage = "student") {
  const v = normalizeTestVault(vault);
  const plan = Object.entries(TEST_PLAN).map(([k,n]) => `${k}: exactly ${n}`).join("\n");
  const evidence = testVaultEvidence(v).join("\n") || "No detailed Vault evidence was supplied.";

  return `You are CareerMitra's Test Zone AI engine.

Create a genuinely personalized self-discovery test for ONE student.
Do not use a generic question bank.
A different Personal Vault must produce meaningfully different questions.

STUDENT STAGE:
${stage}

PERSONAL VAULT:
${JSON.stringify(v, null, 2)}

EXACT PERSONAL EVIDENCE:
${evidence}

QUESTION PLAN:
${plan}
TOTAL: 25

Rules:
- Use the student's actual Vault as the source of personalization.
- Do not invent interests, skills, subjects, roles or experiences.
- Interests & likings: use real interests/hobbies/likings in at least 3 of 4 questions when available.
- Strong subject / skills: use real subjects/skills in at least 3 of 4 when available.
- Career opinion: use the student's field, roles, alternatives, non-negotiable career or reasons across the 5 questions.
- Personality and Situation reaction should measure natural preferences, not sell a career.
- Basic intelligence must be independent of the student's career and have exactly one correct answer.
- Never make the student's non-negotiable career the 'correct' answer.
- Every question has exactly 4 options.
- Non-factual questions: each option has one different Holland code among R,I,A,S,E,C.
- Factual questions: exactly one option has correct:true and the other three have correct:false.
- Options must be realistic, comparable, neutral and similarly attractive.
- No moral winner, no 'best person', no obvious smart/lazy option.
- No duplicate questions.
- basedOn must state the actual Vault evidence used, or 'General reasoning' only for Basic intelligence.

Return ONLY valid JSON:
{"questions":[{"cat":"Category name","basedOn":"actual Vault evidence","q":"question","o":[{"text":"option","trait":"R"},{"text":"option","trait":"I"},{"text":"option","trait":"A"},{"text":"option","trait":"S"}]}]}
`;
}

function validateServerTest(data, vault) {
  const errors = [];
  if (!data || !Array.isArray(data.questions)) return { ok:false, errors:["Missing questions array"] };
  if (data.questions.length !== 25) errors.push(`Expected 25 questions, got ${data.questions.length}`);

  const allowed = new Set(Object.keys(TEST_PLAN));
  const counts = {};
  const seen = new Set();
  const traitCodes = new Set(["R","I","A","S","E","C"]);
  const v = normalizeTestVault(vault);
  const evidence = testVaultEvidence(v).map(x => x.toLowerCase());

  const grounded = (q) => {
    if (q.cat === "Basic intelligence") return true;
    const hay = `${q.basedOn || ""} ${q.q || ""}`.toLowerCase();
    return evidence.some(src => {
      const words = src.replace(/[^a-z0-9 ]/g," ").split(/\s+/).filter(w => w.length >= 4);
      if (!words.length) return false;
      const hits = words.filter(w => hay.includes(w)).length;
      return hits >= 1 || hay.includes(src);
    });
  };

  for (let i=0;i<data.questions.length;i++) {
    const q=data.questions[i];
    const n=i+1;
    if (!q || typeof q !== "object") { errors.push(`Q${n}: invalid object`); continue; }
    if (!allowed.has(q.cat)) errors.push(`Q${n}: invalid category`);
    counts[q.cat]=(counts[q.cat]||0)+1;
    if (!cleanText(q.q)) errors.push(`Q${n}: missing question`);
    if (!cleanText(q.basedOn)) errors.push(`Q${n}: missing basedOn`);
    if (!Array.isArray(q.o) || q.o.length !== 4) { errors.push(`Q${n}: must have exactly 4 options`); continue; }
    const texts=q.o.map(x=>cleanText(x?.text));
    if (texts.some(x=>!x)) errors.push(`Q${n}: empty option`);
    if (new Set(texts.map(x=>x.toLowerCase())).size !== 4) errors.push(`Q${n}: duplicate options`);
    const factual=q.o.some(x=>x && Object.prototype.hasOwnProperty.call(x,"correct"));
    if (factual) {
      const correct=q.o.filter(x=>x?.correct===true).length;
      if (correct!==1) errors.push(`Q${n}: factual question must have exactly one correct option`);
    } else {
      const traits=q.o.map(x=>x?.trait);
      if (traits.some(x=>!traitCodes.has(x))) errors.push(`Q${n}: invalid Holland trait`);
      if (new Set(traits).size!==4) errors.push(`Q${n}: non-factual options need four different traits`);
    }
    if (!grounded(q)) errors.push(`Q${n}: not grounded in supplied Personal Vault`);
    for (let j=0;j<i;j++) {
      const a=cleanText(data.questions[j]?.q).toLowerCase().replace(/[^a-z0-9 ]/g," ").replace(/\s+/g," ");
      const b=cleanText(q.q).toLowerCase().replace(/[^a-z0-9 ]/g," ").replace(/\s+/g," ");
      if (a && b && (a===b || a.includes(b) || b.includes(a))) errors.push(`Q${n}: duplicate/similar question`);
    }
    seen.add(q.id);
  }

  for (const [cat,n] of Object.entries(TEST_PLAN)) {
    if ((counts[cat]||0)!==n) errors.push(`${cat}: expected ${n}, got ${counts[cat]||0}`);
  }
  return { ok: errors.length===0, errors };
}

async function generateServerTest(vault, stage) {
  const prompt = buildServerTestPrompt(vault, stage);
  let ai;

  // ONE Test Zone generation only. Do not perform a second large AI request.
  try {
    ai = await requestAI(prompt, false, false, true);
  } catch (error) {
    error.testGenerationFailed = true;
    throw error;
  }

  let data = parseJSON(ai.text);

  // Be tolerant of models returning {data:{questions:[...]}} or
  // {result:{questions:[...]}} even though the prompt asks for the direct shape.
  if (!data?.questions && data?.data?.questions) data = data.data;
  if (!data?.questions && data?.result?.questions) data = data.result;

  const check = validateServerTest(data, vault);

  if (!check.ok) {
    const e = new Error("AI generated an invalid Test Zone payload.");
    e.testValidationFailed = true;
    e.validationErrors = check.errors;
    throw e;
  }

  return { data, model: ai.model, attempts: ai.attempts };
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  try {
    const body = typeof req.body === "string"
      ? JSON.parse(req.body || "{}")
      : (req.body || {});

    const prompt = cleanText(body.prompt);
    const webSearch = body.webSearch === true;
    const suppliedCareer = cleanText(body.career);

    if (!prompt) {
      return res.status(400).json({ ok: false, error: "Missing prompt" });
    }

    const requestedPurpose = cleanText(body.purpose);
    const isTest = requestedPurpose === "student test generation" || body.testZone === true;

    if (isTest) {
      const vault = normalizeTestVault(body.vault || {});
      const hasVault = testVaultEvidence(vault).length > 0;
      if (!hasVault) {
        return res.status(400).json({
          ok:false,
          ai:false,
          fallbackUsed:false,
          aiFailed:true,
          fallbackAllowed:false,
          error:"Personal Vault data is required for Test Zone generation."
        });
      }

      try {
        const stage = cleanText(body.stage || vault.stage || "student");
        const generated = await generateServerTest(vault, stage);
        return res.status(200).json({
          ok:true,
          ai:true,
          fallbackUsed:false,
          data:generated.data,
          model:generated.model,
          attempts:generated.attempts,
          purpose:"student test generation",
          serverValidated:true
        });
      } catch (error) {
        console.error("CareerMitra Test Zone AI failed", error);
        return res.status(503).json({
          ok:false,
          ai:false,
          fallbackUsed:false,
          aiFailed:true,
          fallbackAllowed:true,
          testValidationFailed:Boolean(error?.testValidationFailed),
          validationErrors:error?.validationErrors || [],
          rateLimited:Number(error?.status)===429,
          retryAfter:error?.retryAfter || null,
          error:cleanText(error?.message || "Test Zone AI temporarily unavailable.")
        });
      }
    }

    let finalPrompt = prompt;
    let sources = [];
    let career = suppliedCareer || extractCareer(prompt);

    if (webSearch) {
      if (!career) {
        return res.status(400).json({
          ok: false,
          error: "Could not determine the exact career."
        });
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
      const badCountry = /melbourne|florida|australia|canada|united states|new york|california|uk orthopedic surgeon jobs/i;

      sources = groups.flat().filter(x => {
        if (!x.url || seen.has(x.url)) return false;
        const combined = `${x.title} ${x.snippet}`;
        // This research panel is India-first. Drop obvious foreign local-service results.
        if (badCountry.test(combined) && !/india|indian/i.test(combined)) return false;
        seen.add(x.url);
        return true;
      })
      .sort((a, b) => sourcePriority(b.url) - sourcePriority(a.url))
      .slice(0, 20);

      const evidence = sources.map((x, i) =>
        `[SOURCE ${i + 1}]\nTITLE: ${x.title}\nURL: ${x.url}\nSNIPPET: ${x.snippet}`
      ).join("\n\n");

      finalPrompt = researchPrompt(career, evidence);
    }

    let ai;
    let usedFallback = false;

    try {
      ai = await requestAI(finalPrompt, webSearch);
    } catch (error) {
      console.error("CareerMitra AI request failed", error);

      // IMPORTANT: live research should not become a blank panel merely
      // because the LLM is temporarily rate-limited.
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
      // AI succeeded, but malformed/incomplete JSON is NOT considered a
      // reason to activate the deterministic fallback immediately. Give AI
      // one dedicated repair pass first.
      if (!data || researchNeedsRepair(data)) {
        try {
          const repairPrompt = `${finalPrompt}

RECOVERY INSTRUCTION:
The previous response was incomplete or malformed. Rebuild the COMPLETE JSON object now. Every major section must contain useful career-specific information grounded in the supplied evidence. Do not omit sections merely because one source is weak.`;
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
