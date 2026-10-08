export const maxDuration = 60;

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

// Keep the router configurable.
// You can override the primary model from Vercel Environment Variables.
const PRIMARY_MODEL =
  process.env.OPENROUTER_MODEL ||
  "nvidia/nemotron-3-ultra-550b-a55b:free";

const FALLBACK_MODELS = [
  PRIMARY_MODEL,
  "nvidia/nemotron-3.5-lightning:free",
  "nvidia/nemotron-3-super-120b-a12b:free",
  "openrouter/free"
].filter((v, i, a) => v && a.indexOf(v) === i);


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

  // Try extracting an object from surrounding model text.
  const a = s.indexOf("{");
  const b = s.lastIndexOf("}");

  if (a >= 0 && b > a) {
    try {
      return JSON.parse(s.slice(a, b + 1));
    } catch (_) {}
  }

  // Try extracting an array.
  const x = s.indexOf("[");
  const y = s.lastIndexOf("]");

  if (x >= 0 && y > x) {
    try {
      return JSON.parse(s.slice(x, y + 1));
    } catch (_) {}
  }

  return null;
}

function extractText(data) {
  const c = data?.choices?.[0];

  if (typeof c?.message?.content === "string") {
    return c.message.content.trim();
  }

  if (Array.isArray(c?.message?.content)) {
    return c.message.content
      .map(x =>
        typeof x === "string"
          ? x
          : x?.text || ""
      )
      .join("")
      .trim();
  }

  if (typeof c?.text === "string") {
    return c.text.trim();
  }

  return "";
}


/* =========================================================
   PURPOSE DETECTION
========================================================= */

function purposeFor(prompt, webSearch) {
  const p = String(prompt || "").toLowerCase();

  if (webSearch) {
    return "live career research";
  }

  if (
    /common ground|both sides|family concerns|student test analysis|decision-support analyst/.test(p)
  ) {
    return "common-ground analysis";
  }

  if (
    /parent|family|sincere|specific|relevant response|concern/.test(p)
  ) {
    return "family question/answer analysis";
  }

  if (
    /complete test|question plan|holland|personal vault|multiple-choice questions/.test(p)
  ) {
    return "student test generation";
  }

  if (
    /personality-and-interest test|holland-code tallies|career counsellor|test responses|rankedcareers|student's actual test zone responses/.test(p)
  ) {
    return "student test answer analysis";
  }

  return "career counselling";
}


/* =========================================================
   GLOBAL AI SYSTEM PROMPT
========================================================= */

async function requestAI(prompt, webSearch = false, repair = false) {
  const key = process.env.OPENROUTER_API_KEY;

  if (!key) {
    throw new Error(
      "OPENROUTER_API_KEY is missing in Vercel Environment Variables."
    );
  }

  const purpose = purposeFor(prompt, webSearch);

  const system = `You are CareerMitra's ${purpose} engine.

Your role is to help a real student make a clearer career decision.

You MUST remain neutral, humble, respectful and evidence-led.

Return ONLY valid JSON.
Never return markdown.
Never return code fences.
Never return explanation outside JSON.

==================================================
CORE CAREERMITRA PRINCIPLES
==================================================

1. USER DATA COMES FIRST

Use only the information supplied by the student/family.

Do not invent:
- interests
- personality traits
- family beliefs
- financial conditions
- skills
- ambitions
- academic ability
- career goals
- preferences

If information is missing, say that it is missing.

2. ZERO INTENTIONAL CAREER BIAS

Do NOT favour or discourage any career because it is:

- popular
- prestigious
- high paying
- socially respected
- government
- private
- technical
- medical
- engineering
- AI-related
- traditional
- modern
- considered "safe"
- considered "future-proof"
- considered "better"
- considered "successful"

A career mentioned by the student is evidence of interest,
NOT proof that it is the correct career.

3. DO NOT PUSH THE NON-NEGOTIABLE CAREER

If the student has supplied a non-negotiable career:

Treat it as an important preference.

Do NOT automatically recommend it.

It must still be compared against:
- Test Zone evidence
- Personal Vault evidence
- actual answers
- skills
- interests
- realistic requirements
- family perspective when relevant

4. DO NOT PUNISH THE NON-NEGOTIABLE CAREER

The opposite is also important.

Do not deliberately lower its score simply because it is the student's dream.

Evaluate it fairly.

5. NO STEREOTYPES

Do not assume that:

- a student who likes mathematics must become an engineer
- a student who likes biology must become a doctor
- a student who likes coding must become a software engineer
- a student who likes flying must become a pilot
- a student who likes helping people must become a doctor
- a student who likes business must become an entrepreneur
- a high-income career is preferable
- a government career is safer
- a private career is better
- a particular gender is suited to a particular career
- family income determines what career the student should choose

Only the supplied evidence can support such conclusions.

6. MIXED EVIDENCE MUST STAY MIXED

If the evidence points in different directions:

Say so.

Do not force a clean conclusion.

Do not manufacture certainty.

7. FEWER RECOMMENDATIONS ARE BETTER THAN WRONG RECOMMENDATIONS

If only one career is genuinely supported, return one.

If two are supported, return two.

Do not fill a Top 3 list with weak candidates.

8. SIMPLE LANGUAGE

Use:
- easy English
- short sentences
- soft tone
- polite language
- humble wording

Avoid:
- "obviously"
- "definitely"
- "clearly"
- "the best career"
- "you must"
- "you should definitely"
- "this is perfect for you"

Prefer:
- "your answers suggest"
- "this may indicate"
- "there is some evidence"
- "this seems worth exploring"
- "the evidence is mixed"
- "more information would help"

9. EVIDENCE VS INTERPRETATION

Always distinguish between:

DIRECT EVIDENCE:
What the student actually entered.

INTERPRETATION:
What the AI reasonably infers from that evidence.

UNCERTAINTY:
What cannot be determined yet.

10. ONE ANSWER MUST NEVER CONTROL THE WHOLE RESULT

Do not recommend a career from one question.

Look for patterns across multiple answers.

==================================================
TEST ZONE RULES
==================================================

When generating the student test:

The test must be personalised from the complete Personal Vault.

The test should understand:

- interests
- hobbies
- likings
- strong subjects
- preferred roles
- non-negotiable career
- alternative careers
- chosen field
- why the student chose the field
- why the student rejected other fields
- skills
- life stage

Do NOT simply repeat the vault back as questions.

The test should explore the student.

The test should contain different types of questions.

PERSONALITY QUESTIONS:
No correct answer.

SITUATIONAL QUESTIONS:
No morally superior answer.

INTEREST QUESTIONS:
Should explore the student's actual interests.

SUBJECT/SKILL QUESTIONS:
Should relate to the student's actual subjects and skills.

CAREER QUESTIONS:
Should compare possibilities neutrally.

KNOWLEDGE QUESTIONS:
Must have exactly ONE objectively correct answer.

==================================================
TEST OPTION QUALITY
==================================================

For every multiple-choice question:

- exactly 4 options
- options must be logically possible
- options must be relevant
- options must be similar in style
- options should be reasonably similar in length
- do not make one option dramatically more detailed
- do not make one option obviously positive
- do not make one option obviously negative
- do not use jokes as distractors
- do not use nonsense options
- do not use "all of the above" unless genuinely necessary
- do not use "none of the above" unless genuinely necessary
- do not make the preferred career the obvious correct answer
- do not make the student's non-negotiable career appear repeatedly
- do not use the same answer position repeatedly

For personality/situation questions:

There should NOT be an obviously "good" personality answer.

For example, do NOT create:

A. I carefully analyse everything.
B. I ignore all problems.
C. I never care about anything.
D. I give up immediately.

That is biased.

Instead create genuinely different reasonable behaviours.

==================================================
CAREER NEUTRALITY
==================================================

Never assume:

Career A > Career B.

Compare careers based on the supplied student evidence.

A career may be suitable because of one combination of evidence.

Another student with different evidence may receive a different result.

==================================================
FAMILY ANALYSIS
==================================================

Family answers must be interpreted carefully.

Generic statements such as:

"I support whatever he wants."

"I don't care."

"Money is no problem."

"I trust my child."

"No problem."

must NOT be treated as evidence supporting a specific career.

A family statement mentioning a specific career may be evidence of a preference.

A family concern may be evidence of a constraint.

Do not convert general support into career support.

Do not invent family preferences.

==================================================
COMMON GROUND
==================================================

For common-ground analysis:

A career must have:

1. student-side evidence
AND
2. genuine family-side evidence

Do not select a career only because:
- it pays well
- it is popular
- it is already in the database
- it sounds respectable
- it is technically related
- it is medically related
- it appears in the student's non-negotiable field

If family evidence conflicts with the career:

Record the conflict.

Do not hide it.

==================================================
LIVE RESEARCH
==================================================

For live career research:

Keep the EXACT career requested.

Do not silently broaden or replace it.

Prefer India-specific sources.

Never invent:
- URL
- salary
- qualification
- registration requirement
- statistic
- demand claim

==================================================
${webSearch ? `
LIVE RESEARCH QUALITY:

Use the web evidence supplied in the user message.

Cross-check important claims where possible.

Prefer:

- official Indian authorities
- government sources
- medical boards
- universities
- established Indian hospitals
- reputable Indian job portals
- professional organisations

Do not treat one job listing as proof of national demand.

Do not treat search-result volume as a national demand statistic.

For medical careers:
- distinguish MBBS
- registration
- postgraduate specialty
- fellowship/subspecialty
- advanced training

Do not claim that a fellowship is legally mandatory unless the supplied evidence supports it.

For salary:
Use ranges/context only when supported.

Mention that salary can vary by:
- experience
- location
- employer
- public/private setting
- practice type

` : ""}

==================================================
RECOVERY MODE
==================================================

${repair ? `
This is a recovery pass.

The previous AI response was incomplete, malformed or insufficient.

Rebuild the requested output carefully from the supplied evidence.

Do not reduce quality merely to complete the response.

Return the complete JSON structure requested by the user.
` : ""}
`;

  /*
    OpenRouter can perform provider/model fallback.

    We intentionally do not repeatedly hammer 429 responses.
    A 429 may represent account-level quota exhaustion.
  */

  const maxAttempts = repair ? 2 : 2;

  const timeoutMs = webSearch
    ? 18000
    : 12000;

  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {

    const controller = new AbortController();

    const timer = setTimeout(() => {
      controller.abort();
    }, timeoutMs);

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

            model: PRIMARY_MODEL,

            models: FALLBACK_MODELS,

            messages: [
              {
                role: "system",
                content: system
              },
              {
                role: "user",
                content: prompt
              }
            ],

            temperature: webSearch
              ? 0.05
              : 0.15,

            max_tokens: webSearch
              ? 6500
              : 6000,

            provider: {
              allow_fallbacks: true,
              sort: "throughput"
            }

          }),

          signal: controller.signal
        }
      );

      const raw = await response.text();

      let data = null;

      try {
        data = JSON.parse(raw);
      } catch (_) {}

      if (!response.ok) {

        const error = new Error(
          cleanText(
            data?.error?.message ||
            data?.error ||
            `OpenRouter HTTP ${response.status}`
          )
        );

        error.status = response.status;

        error.retryAfter =
          response.headers.get("retry-after") ||
          null;

        error.providerCode =
          data?.error?.metadata?.provider_code ||
          null;

        throw error;
      }

      const text = extractText(data);

      if (!text) {
        throw new Error(
          "OpenRouter returned an empty AI response."
        );
      }

      return {
        text,
        model: data?.model || PRIMARY_MODEL,
        attempts: attempt
      };

    } catch (error) {

      lastError = error;

      const status =
        Number(error?.status || 0);

      /*
        Do not repeatedly retry 429.
        If account quota is exhausted, immediate retries
        do not magically restore quota.
      */

      if (status === 429) {
        break;
      }

      const retryable =
        !status ||
        [
          408,
          409,
          425,
          500,
          502,
          503,
          504
        ].includes(status);

      if (
        attempt < maxAttempts &&
        retryable
      ) {

        const wait =
          Math.min(
            1200,
            350 * attempt
          );

        await new Promise(
          resolve =>
            setTimeout(resolve, wait)
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

  if (cleanText(suppliedCareer)) {
    return cleanText(suppliedCareer);
  }

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

function sourcePriority(url) {

  const u =
    String(url || "").toLowerCase();

  let score = 20;

  if (u.includes("nmc.org.in"))
    score = 120;

  else if (u.includes("natboard.edu.in"))
    score = 118;

  else if (u.includes("nbe.edu.in"))
    score = 118;

  else if (u.includes("mcc.nic.in"))
    score = 116;

  else if (u.includes("aiimsexams.ac.in"))
    score = 114;

  else if (u.includes("aiims.edu"))
    score = 112;

  else if (u.includes("apollohospitals.com"))
    score = 95;

  else if (u.includes("fortishealthcare.com"))
    score = 93;

  else if (u.includes("maxhealthcare.in"))
    score = 93;

  else if (u.includes("medanta.org"))
    score = 93;

  else if (u.includes("in.indeed.com"))
    score = 88;

  else if (u.includes("naukri.com"))
    score = 82;

  else if (u.includes("linkedin.com"))
    score = 70;

  else if (u.includes("who.int"))
    score = 65;

  else if (u.includes(".gov.in"))
    score = 100;

  else if (u.includes(".ac.in"))
    score = 90;

  return score;
}


/* =========================================================
   WEB SEARCH
========================================================= */

async function searchWeb(query) {

  try {

    const url =
      "https://www.bing.com/search?format=rss&q=" +
      encodeURIComponent(query);

    const r = await fetch(
      url,
      {
        headers: {
          "User-Agent":
            "Mozilla/5.0 CareerMitra/1.0"
        }
      }
    );

    if (!r.ok) {
      return [];
    }

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

        const clean = v =>
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
          title: clean(title),
          url: clean(link),
          snippet: clean(snippet)
        };

      })
      .filter(
        x =>
          x.title &&
          /^https?:\/\//i.test(x.url)
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
You are CareerMitra's senior India-focused career research analyst.

EXACT CAREER TO RESEARCH:
${career}

DO NOT CHANGE THIS CAREER.

If the input contains a specialization,
research that specialization exactly.

COUNTRY:
India

LIVE WEB EVIDENCE:
${evidence || "No usable live source was retrieved."}

Return ONLY one valid JSON object.

Use exactly these keys:

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

1. EXACT CAREER

Do not substitute a nearby career.

For example, if the career is:

"orthopedic surgeon with spine speciality"

keep the spine specialization central.

2. INDIA FIRST

Prioritize:

- NMC
- NBEMS
- MCC
- AIIMS
- Indian government sources
- Indian medical institutions
- established Indian hospitals
- reputable Indian job sources

3. MEDICAL PATHWAY

Where applicable, clearly separate:

- MBBS
- registration
- postgraduate specialty
- advanced fellowship/subspecialty training

Do not imply that a fellowship is legally mandatory unless the evidence supports it.

4. PAY

Never invent a precise salary.

Use source-supported ranges where available.

Explain variation by:

- experience
- city
- employer
- private/public practice
- practice type

5. DEMAND

Do not call a career "high demand"
merely because jobs exist.

Explain the evidence and limitations.

6. MARKET REQUIREMENTS

Give actual:

- qualifications
- skills
- registration/licensing
- experience
- employer expectations

only where supported.

7. PATH

Give a practical sequence.

8. ALTERNATIVES

Give genuinely comparable alternatives.

9. PUBLIC DISCUSSION

Summarise recurring discussion themes.

Do not treat online discussions as statistical evidence.

10. SOURCES

Only use URLs present in the supplied evidence.

Never manufacture URLs.

11. COMPLETENESS

Do not leave major fields empty simply because
one source is weak.

Use stable professional context carefully,
and mark uncertainty.

12. NO FILLER

Avoid generic sentences that provide no useful information.

13. JSON ONLY.

No markdown fences.
No explanation outside JSON.
`;
}


/* =========================================================
   NORMALISE RESEARCH
========================================================= */

function normalizeResearch(
  data,
  career,
  sources
) {

  const d =
    data &&
    typeof data === "object"
      ? { ...data }
      : {};

  d.career = career;

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
    const [key, list]
    of Object.entries(aliases)
  ) {

    if (
      d[key] == null ||
      d[key] === ""
    ) {

      for (const a of list) {

        if (
          d[a] != null &&
          d[a] !== ""
        ) {

          d[key] = d[a];
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

  for (const k of arrays) {

    if (!Array.isArray(d[k])) {

      d[k] =
        d[k]
          ? [String(d[k])]
          : [];

    }
  }

  /*
    Never trust URLs invented by the AI.

    Only expose URLs that were actually retrieved
    by CareerMitra's live search.
  */

  if (
    Array.isArray(sources) &&
    sources.length
  ) {

    d.sources =
      sources.map(x => ({
        title: cleanText(x.title),
        url: cleanText(x.url),
        snippet: cleanText(x.snippet),
        why_relevant:
          "Live source retrieved for this career research."
      }));

  } else if (!d.sources.length) {

    d.sources = [];

  }

  if (!d.what_it_involves) {

    d.what_it_involves =
      `The ${career} role involves applying relevant knowledge and practical skills to solve problems and deliver useful outcomes.`;

  }

  if (!d.pay_india) {

    d.pay_india =
      "Current India salary could not be reliably verified from the retrieved sources.";

  }

  if (!d.demand) {

    d.demand =
      "Current demand could not be reliably verified from the retrieved sources.";

  }

  if (!d.future_growth) {

    d.future_growth =
      "Future growth could not be reliably verified from the retrieved sources.";

  }

  return d;
}


/* =========================================================
   LAST-RESORT RESEARCH FALLBACK
========================================================= */

function webFallbackResearch(
  career,
  sources
) {

  const usable =
    sources.slice(0, 12);

  const sourceList =
    usable.map(x => ({
      title: x.title,
      url: x.url,
      snippet: x.snippet,
      why_relevant:
        "Retrieved as live evidence for this exact career in India."
    }));

  const text =
    usable
      .map(
        x =>
          `${x.title} ${x.snippet}`
      )
      .join(" ");

  const medical =
    /surgeon|doctor|physician|orthopedic|orthopaedic|cardio|neuro|radiolog|dermatolog|anesthes|anaesthes|patholog|pediatric|paediatric|oncolog|dentist/i
      .test(career);

  const spine =
    /spine|spinal/i.test(career);

  /*
    This is deliberately a LAST-RESORT
    source-backed response.

    It should never pretend to be AI synthesized.
  */

  const path = medical

    ? [

        "Complete the required undergraduate medical education pathway in India, typically MBBS for a medical specialist career.",

        "Complete the applicable compulsory registration and internship requirements under the current Indian regulatory framework.",

        "Enter the relevant postgraduate specialty pathway through the currently applicable entrance and counselling process.",

        spine
          ? "After orthopaedic specialty training, build advanced spine expertise through appropriate supervised training or fellowship where applicable."
          : "Build supervised specialist clinical and procedural experience.",

        "Continue professional development, evidence-based practice and any applicable registration or credential requirements."

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


  const requirements =
    usable
      .slice(0, 8)
      .map(
        x =>
          `${x.title}${x.snippet ? ` — ${x.snippet}` : ""}`
      );


  const hasSalaryEvidence =
    /salary|lakh|lpa|₹|rs\.?\s?\d|inr/i
      .test(text);


  const hasTrainingEvidence =
    /mbbs|ms |dnb|fellowship|registration|nmc|nbems|residency/i
      .test(text);


  return normalizeResearch(

    {

      career,

      what_it_involves:
        medical

          ? `${career} is a specialist medical career involving patient assessment, diagnosis, treatment planning, procedures or surgery where applicable, follow-up and continued professional learning. The exact scope depends on the specialist's training and practice setting.`

          : `${career} involves applying the knowledge and practical skills specific to the role, working with relevant tools or systems, solving real problems and delivering outcomes for an employer or client.`,

      pros:

        medical

          ? [

              "High level of specialised professional responsibility.",

              "Potential to make a direct impact on patient outcomes.",

              "Scope to build deep expertise and, depending on the career, teaching, research or private-practice opportunities."

            ]

          : [

              "Opportunity to develop specialised expertise.",

              "Potential for multiple employer or industry pathways as experience grows.",

              "Scope for continued learning and progression."

            ],


      cons:

        medical

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


      pay_india:

        hasSalaryEvidence

          ? "The live results contain salary or earning references, but they should be interpreted by experience, city, employer and practice type. Exact figures are not asserted here without a reliable cross-source salary dataset."

          : "No sufficiently reliable current India salary range was established from the retrieved sources; salary varies substantially by experience, location, employer and practice type.",


      market_requirements:
        requirements,


      demand:

        usable.length

          ? `Live India search results were found for ${career}. They show current activity around the career, but search-result volume alone is not a national demand statistic. Demand should be interpreted with location, employer, experience and specialization in mind.`

          : `No usable live India sources were retrieved for ${career}.`,


      future_growth:

        medical

          ? "The long-term outlook depends on population healthcare needs, specialist capacity, technology, referral patterns and the balance between public and private healthcare. Current growth should be treated as an evidence-based judgement rather than a guaranteed outcome."

          : "Future growth depends on industry demand, technology, employer needs and the ability to keep skills current.",


      step_by_step_path:
        path,


      academic_education:
        education,


      vocational_diploma:

        medical

          ? []

          : [
              "Diploma or vocational routes may be relevant only if they are explicitly accepted for the target role."
            ],


      certifications:

        medical

          ? [

              "Current registration and specialist qualification requirements should be verified with the applicable Indian authority.",

              hasTrainingEvidence
                ? "The retrieved sources contain training or qualification references; verify the exact current pathway before making an education decision."
                : "No specific certification claim is made because the retrieved evidence was insufficient."

            ]

          : [

              "Choose certifications that are explicitly relevant to the target job rather than collecting certificates without practical experience."

            ],


      job_ready_skills:

        medical

          ? [

              "Clinical assessment and decision-making",

              "Relevant procedural or surgical skills under appropriate supervision",

              "Patient and family communication",

              "Imaging or diagnostic interpretation where relevant",

              "Evidence-based practice",

              "Teamwork and multidisciplinary coordination"

            ]

          : [

              "Role-specific technical skills",

              "Communication",

              "Problem solving",

              "Practical project or work evidence",

              "Interview and workplace skills"

            ],


      alternatives:

        medical

          ? [

              "Related specialist pathways within the same broad medical field",

              "Academic, teaching or research pathways after specialist training",

              "Hospital-based clinical roles with adjacent expertise"

            ]

          : [],


      barriers:

        medical

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


      rewards:

        medical

          ? [

              "Specialist expertise",

              "Potential to improve patient outcomes",

              "Professional growth and teaching or research opportunities",

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


      sources:
        sourceList

    },

    career,
    sourceList

  );
}


/* =========================================================
   RESEARCH QUALITY CHECK
========================================================= */

function researchNeedsRepair(data) {

  if (
    !data ||
    typeof data !== "object"
  ) {
    return true;
  }

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

  const missing =
    required.filter(k =>

      data[k] == null ||
      data[k] === "" ||
      (
        Array.isArray(data[k]) &&
        data[k].length === 0
      )

    );

  return missing.length >= 4;
}


/* =========================================================
   VERCEL API HANDLER
========================================================= */

export default async function handler(
  req,
  res
) {

  if (req.method !== "POST") {

    return res.status(405).json({

      ok: false,

      error:
        "Method not allowed"

    });

  }


  try {

    const body =
      typeof req.body === "string"

        ? JSON.parse(
            req.body || "{}"
          )

        : (
            req.body || {}
          );


    const prompt =
      cleanText(
        body.prompt
      );


    const webSearch =
      body.webSearch === true;


    const suppliedCareer =
      cleanText(
        body.career
      );


    if (!prompt) {

      return res.status(400).json({

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
      extractCareer(prompt);


    /* =====================================================
       LIVE CAREER RESEARCH
    ===================================================== */

    if (webSearch) {

      if (!career) {

        return res.status(400).json({

          ok: false,

          error:
            "Could not determine the exact career."

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


      const groups =
        await Promise.all(
          queries.map(searchWeb)
        );


      const seen =
        new Set();


      const badCountry =
        /melbourne|florida|australia|canada|united states|new york|california|uk orthopedic surgeon jobs/i;


      sources =
        groups
          .flat()
          .filter(x => {

            if (
              !x.url ||
              seen.has(x.url)
            ) {
              return false;
            }


            const combined =
              `${x.title} ${x.snippet}`;


            /*
              CareerMitra is India-first.

              Remove obvious foreign local-service results.
            */

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


            seen.add(x.url);

            return true;

          })


          .sort(
            (a, b) =>
              sourcePriority(b.url) -
              sourcePriority(a.url)
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
          .join("\n\n");


      finalPrompt =
        researchPrompt(
          career,
          evidence
        );

    }


    let ai;

    let usedFallback =
      false;


    /* =====================================================
       PRIMARY AI REQUEST
    ===================================================== */

    try {

      ai =
        await requestAI(
          finalPrompt,
          webSearch
        );

    } catch (error) {

      console.error(
        "CareerMitra AI request failed",
        error
      );


      /*
        IMPORTANT:

        Live research gets source-backed recovery
        ONLY after AI has failed.

        Normal Test Zone / analysis does NOT
        silently manufacture a result here.
      */

      if (
        webSearch &&
        career &&
        sources.length
      ) {

        return res.status(200).json({

          ok: true,

          ai: false,

          fallbackUsed: true,

          aiFailed: true,

          rateLimited:
            Number(error?.status) === 429,

          retryAfter:
            error?.retryAfter ||
            null,

          data:
            webFallbackResearch(
              career,
              sources
            ),

          model: null,

          sources,

          warning:
            "Source-backed recovery was used only after the AI recovery chain failed."

        });

      }


      const status =
        Number(
          error?.status || 503
        );


      return res.status(
        status === 429
          ? 429
          : 503
      ).json({

        ok: false,

        aiFailed: true,

        fallbackAllowed: true,

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
       PARSE AI RESPONSE
    ===================================================== */

    let data =
      parseJSON(
        ai.text
      );


    /* =====================================================
       LIVE RESEARCH AI REPAIR
    ===================================================== */

    if (webSearch) {

      /*
        A successful API response is not automatically
        a successful research response.

        If JSON is incomplete, give AI another chance.
      */

      if (
        !data ||
        researchNeedsRepair(data)
      ) {

        try {

          const repairPrompt =
            `${finalPrompt}

RECOVERY INSTRUCTION:

The previous response was incomplete or malformed.

Rebuild the COMPLETE JSON object now.

Every major section must contain useful
career-specific information grounded in
the supplied evidence.

Do not omit sections merely because
one source is weak.

Do not invent unsupported facts.

Return JSON only.`;


          const repaired =
            await requestAI(
              repairPrompt,
              true,
              true
            );


          const repairedData =
            parseJSON(
              repaired.text
            );


          if (
            repairedData &&
            !researchNeedsRepair(
              repairedData
            )
          ) {

            data =
              repairedData;

            ai =
              repaired;

          }

        } catch (
          repairError
        ) {

          console.error(
            "CareerMitra AI research repair failed",
            repairError
          );

        }

      }


      /*
        Only after the AI response AND AI repair
        fail do we use the deterministic fallback.
      */

      if (data) {

        data =
          normalizeResearch(
            data,
            career,
            sources
          );

      } else {

        data =
          webFallbackResearch(
            career,
            sources
          );

        usedFallback =
          true;

      }

    }


    /* =====================================================
       SUCCESS
    ===================================================== */

    return res.status(200).json({

      ok: true,

      ai:
        !usedFallback,

      fallbackUsed:
        usedFallback,

      data:
        data || ai.text,

      model:
        ai.model,

      attempts:
        ai.attempts,

      sources

    });


  } catch (error) {

    console.error(
      "CareerMitra API ERROR",
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
