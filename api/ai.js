export const maxDuration = 60;

const OPENROUTER_URL =
  "https://openrouter.ai/api/v1/chat/completions";

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

  const objStart = s.indexOf("{");
  const objEnd = s.lastIndexOf("}");

  if (objStart >= 0 && objEnd > objStart) {
    try {
      return JSON.parse(
        s.slice(objStart, objEnd + 1)
      );
    } catch (_) {}
  }

  const arrStart = s.indexOf("[");
  const arrEnd = s.lastIndexOf("]");

  if (arrStart >= 0 && arrEnd > arrStart) {
    try {
      return JSON.parse(
        s.slice(arrStart, arrEnd + 1)
      );
    } catch (_) {}
  }

  return null;
}

function extractText(data) {
  const choice = data?.choices?.[0];

  if (
    typeof choice?.message?.content === "string"
  ) {
    return choice.message.content.trim();
  }

  if (Array.isArray(choice?.message?.content)) {
    return choice.message.content
      .map(x =>
        typeof x === "string"
          ? x
          : x?.text || ""
      )
      .join("")
      .trim();
  }

  if (typeof choice?.text === "string") {
    return choice.text.trim();
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
    /complete test|question plan|holland|personal vault|multiple-choice questions/.test(
      p
    )
  ) {
    return "student test generation";
  }

  if (
    /personality-and-interest test|holland-code tallies|career counsellor|test responses|rankedcareers|student's actual test zone responses/.test(
      p
    )
  ) {
    return "student test analysis";
  }

  if (
    /common ground|both sides|family concerns|decision-support analyst/.test(
      p
    )
  ) {
    return "student-family common-ground analysis";
  }

  if (
    /parent|family|sincere|specific|relevant response|concern/.test(
      p
    )
  ) {
    return "family analysis";
  }

  return "career counselling";
}


/* =========================================================
   CORE AI REQUEST
========================================================= */

async function requestAI(
  prompt,
  webSearch = false,
  repair = false
) {
  const key =
    process.env.OPENROUTER_API_KEY;

  if (!key) {
    throw new Error(
      "OPENROUTER_API_KEY is missing in Vercel Environment Variables."
    );
  }

  const purpose =
    purposeFor(prompt, webSearch);

  const system = `
You are CareerMitra's ${purpose} engine.

You are assisting a real student.

Your responsibility is to understand the information supplied by
the student or family and respond carefully, neutrally and respectfully.

==================================================
CORE PRINCIPLE
==================================================

DO NOT DECIDE WHAT THE USER SHOULD WANT.

DO NOT PUSH A CAREER.

DO NOT ASSUME A CAREER IS BETTER.

DO NOT REWARD A CAREER BECAUSE IT IS:
- popular
- prestigious
- high paying
- socially respected
- traditionally preferred
- government
- private
- technical
- medical
- fashionable
- considered "safe"

Only use evidence actually supplied by the user or retrieved
from the explicitly requested live research.

==================================================
NEUTRALITY
==================================================

- Every career must start with a neutral prior.
- A named career is only a preference/evidence signal.
- A non-negotiable career is NOT automatically the best career.
- A parent's preference is NOT automatically correct.
- A student's preference is NOT automatically correct.
- Neither side should dominate merely because it is the student
  or the parent.
- Do not infer personality from gender, income, location,
  school, family background, marks or social stereotypes.
- Do not assume engineering is better than medicine.
- Do not assume medicine is better than engineering.
- Do not assume government jobs are safer.
- Do not assume private jobs are better.
- Do not assume high salary means high suitability.
- Do not assume passion means suitability.
- Do not assume family concern means opposition.
- Do not assume family support means support for a particular career.

==================================================
EVIDENCE RULE
==================================================

Every meaningful conclusion must be connected to evidence.

Use:

1. Direct evidence
2. Repeated evidence
3. Consistent evidence
4. Reasonable uncertainty

Do NOT convert weak evidence into certainty.

If evidence conflicts:

say that it conflicts.

If evidence is insufficient:

say that it is insufficient.

If two careers are similarly supported:

do not artificially separate them.

If only two careers genuinely fit:

return two.

Never create a third career simply to complete a Top 3 list.

==================================================
LANGUAGE
==================================================

Use:

- very simple English
- respectful language
- soft tone
- humble wording
- short explanations
- clear reasoning

Avoid:

- harsh language
- absolute statements
- "you must"
- "obviously"
- "clearly this is the best"
- "you are definitely suited"
- "this is the perfect career"

Prefer:

- "The available evidence suggests..."
- "This may indicate..."
- "There is some support for..."
- "The evidence is mixed..."
- "This cannot be concluded confidently yet..."

==================================================
STUDENT TEST
==================================================

When generating questions:

- Use the actual Personal Vault.
- Questions must be meaningfully connected to Vault data.
- Do not repeatedly ask about the same interest.
- Do not fabricate an interest.
- Do not fabricate a skill.
- Do not fabricate a career preference.
- Do not make questions designed to push a particular career.
- Do not make the "correct" personality answer obvious.
- Do not use emotionally loaded options.
- Do not make one option sound smarter.
- Do not make one option sound more ambitious.
- Do not make one option sound safer.
- Do not make one option socially superior.

Options must be:

- plausible
- balanced
- grammatically similar
- comparable in length
- neutral in emotional tone
- mutually understandable
- relevant to the question

Avoid absurd distractors.

Avoid "obviously wrong" options.

Avoid options such as:
"Do nothing"
"Become successful"
"Choose the highest salary"

unless the question genuinely requires such an option.

For career-related questions, do not directly ask:
"Would you choose X?"

Instead test underlying preferences such as:
- type of problem
- work environment
- depth vs variety
- people interaction
- uncertainty tolerance
- learning style
- practical vs theoretical work
- responsibility preference
- work rhythm
- collaboration
- creativity
- analytical thinking

The test should discover patterns, not confirm a predetermined answer.

==================================================
TEST ANALYSIS
==================================================

When analysing the student's completed test:

Use BOTH:

A. Test responses
B. Personal Vault

Do not rely only on the Holland score.

Do not let one answer decide the result.

Look for:

- repeated patterns
- contradictions
- stable preferences
- uncertain areas
- work-style signals
- interest signals
- subject signals
- skill signals
- role preferences
- career preferences

Clearly distinguish:

Evidence
from
Interpretation.

Do not manufacture certainty.

==================================================
FAMILY ANALYSIS
==================================================

Family answers must be interpreted carefully.

Examples:

"I support whatever he wants"

means:

general support.

It does NOT mean:

support for every specific career.

"No problem with salary"

does NOT mean:

salary is an important positive preference.

"I want him to become a pilot"

IS:

an explicit family preference for pilot.

"Surgeon is a lifesaving job"

is:

a positive statement about surgeon,
but NOT automatically proof that surgeon
matches every other family concern.

"Everyone has to go away"

does NOT automatically mean:
location is irrelevant.

Always preserve the actual meaning of the parent's answer.

==================================================
COMMON GROUND
==================================================

For student-family common ground:

A career should be considered only when:

1. Student evidence supports it.
2. Family evidence supports or meaningfully accommodates it.
3. No major unresolved conflict makes the match misleading.

Generic family support is NOT career-specific evidence.

A career must not enter Top 3 only because:
- it pays well
- it is prestigious
- it is common
- AI thinks it is popular
- the student typed it once
- the parent mentioned a related field once

Show conflicts honestly.

==================================================
LIVE CAREER RESEARCH
==================================================

When live research is requested:

- Research the EXACT career.
- Preserve specialization.
- Prefer India.
- Do not replace a specialized role with a generic career.
- Use retrieved evidence.
- Never invent URLs.
- Never invent salary numbers.
- Never invent regulations.
- Never invent demand statistics.

For medical careers:

separate:

MBBS
registration
postgraduate specialty
advanced specialty/fellowship

where applicable.

==================================================
OUTPUT
==================================================

Return ONLY valid JSON.

No markdown.

No code fences.

No explanation outside JSON.

${
  repair
    ? `
THIS IS A RECOVERY PASS.

A previous response was malformed or incomplete.

Rebuild the requested response completely.

Do not reduce quality merely to produce valid JSON.
`
    : ""
}
`;

  /*
   * IMPORTANT RATE-LIMIT STRATEGY
   *
   * We do NOT aggressively retry 429.
   *
   * A 429 often means account/model/provider quota.
   * Repeating the same request immediately only makes
   * the situation worse.
   */

  const maxAttempts = 2;

  const timeoutMs =
    webSearch
      ? 18000
      : 12000;

  let lastError = null;

  for (
    let attempt = 1;
    attempt <= maxAttempts;
    attempt++
  ) {
    const controller =
      new AbortController();

    const timer =
      setTimeout(
        () => controller.abort(),
        timeoutMs
      );

    try {
      const model =
        FALLBACK_MODELS[
          (attempt - 1) %
            FALLBACK_MODELS.length
        ];

      const response =
        await fetch(
          OPENROUTER_URL,
          {
            method: "POST",

            headers: {
              Authorization:
                `Bearer ${key}`,

              "Content-Type":
                "application/json",

              "HTTP-Referer":
                process.env.SITE_URL ||
                "https://careermitra.vercel.app",

              "X-Title":
                "CareerMitra"
            },

            body:
              JSON.stringify({
                model,

                models:
                  FALLBACK_MODELS,

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

                temperature:
                  webSearch
                    ? 0.05
                    : 0.15,

                max_tokens:
                  webSearch
                    ? 6500
                    : 6000,

                provider: {
                  allow_fallbacks: true,
                  sort: "throughput"
                }
              }),

            signal:
              controller.signal
          }
        );

      const raw =
        await response.text();

      let data = null;

      try {
        data =
          JSON.parse(raw);
      } catch (_) {}

      if (!response.ok) {
        const error =
          new Error(
            cleanText(
              data?.error?.message ||
              data?.error ||
              `OpenRouter HTTP ${response.status}`
            )
          );

        error.status =
          response.status;

        error.retryAfter =
          response.headers.get(
            "retry-after"
          );

        error.providerCode =
          data?.error?.metadata
            ?.provider_code ||
          null;

        throw error;
      }

      const text =
        extractText(data);

      if (!text) {
        throw new Error(
          "OpenRouter returned an empty AI response."
        );
      }

      return {
        text,
        model:
          data?.model ||
          model ||
          PRIMARY_MODEL,
        attempts: attempt
      };

    } catch (error) {

      lastError = error;

      const status =
        Number(
          error?.status || 0
        );

      /*
       * NEVER HAMMER 429
       */
      if (status === 429) {

        if (
          attempt < maxAttempts
        ) {

          const retryAfter =
            Number(
              error?.retryAfter ||
              0
            );

          const wait =
            Math.min(
              5000,
              Math.max(
                1500,
                retryAfter * 1000
              )
            );

          await new Promise(
            resolve =>
              setTimeout(
                resolve,
                wait
              )
          );

          continue;
        }

        break;
      }

      /*
       * Retry infrastructure
       * failures only.
       */
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
            1500,
            400 * attempt
          );

        await new Promise(
          resolve =>
            setTimeout(
              resolve,
              wait
            )
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
  if (
    cleanText(
      suppliedCareer
    )
  ) {
    return cleanText(
      suppliedCareer
    );
  }

  const p =
    cleanText(prompt);

  const patterns = [

    /EXACT CAREER\s*:\s*["“']?(.+?)["”']?(?:\n|$)/i,

    /non[- ]negotiable(?: career)?\s*[:\-]\s*["“']?(.+?)["”']?(?:\n|$)/i,

    /exact career\s*[:\-]\s*["“']?(.+?)["”']?(?:\n|$)/i,

    /career\s+of\s+["“']?(.+?)["”']?(?:\s+in India|\n|$)/i,

    /career\s*[:\-]\s*["“']?(.+?)["”']?(?:\n|$)/i
  ];

  for (
    const re of patterns
  ) {

    const match =
      p.match(re);

    if (match?.[1]) {

      return cleanText(
        match[1]
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
    String(url || "")
      .toLowerCase();

  let score = 20;

  if (
    u.includes("nmc.org.in")
  ) {
    score = 120;
  }

  else if (
    u.includes("natboard.edu.in")
  ) {
    score = 118;
  }

  else if (
    u.includes("nbe.edu.in")
  ) {
    score = 118;
  }

  else if (
    u.includes("mcc.nic.in")
  ) {
    score = 116;
  }

  else if (
    u.includes("aiimsexams.ac.in")
  ) {
    score = 114;
  }

  else if (
    u.includes("aiims.edu")
  ) {
    score = 112;
  }

  else if (
    u.includes(".gov.in")
  ) {
    score = 110;
  }

  else if (
    u.includes(".ac.in")
  ) {
    score = 100;
  }

  else if (
    u.includes("apollohospitals.com")
  ) {
    score = 95;
  }

  else if (
    u.includes("fortishealthcare.com")
  ) {
    score = 93;
  }

  else if (
    u.includes("maxhealthcare.in")
  ) {
    score = 93;
  }

  else if (
    u.includes("medanta.org")
  ) {
    score = 93;
  }

  else if (
    u.includes("in.indeed.com")
  ) {
    score = 88;
  }

  else if (
    u.includes("naukri.com")
  ) {
    score = 82;
  }

  else if (
    u.includes("linkedin.com")
  ) {
    score = 70;
  }

  else if (
    u.includes("who.int")
  ) {
    score = 65;
  }

  return score;
}


/* =========================================================
   WEB SEARCH
========================================================= */

async function searchWeb(
  query
) {

  try {

    const url =
      "https://www.bing.com/search?format=rss&q=" +
      encodeURIComponent(query);

    const response =
      await fetch(
        url,
        {
          headers: {
            "User-Agent":
              "Mozilla/5.0 CareerMitra/1.0"
          }
        }
      );

    if (!response.ok) {
      return [];
    }

    const xml =
      await response.text();

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

        const clean =
          v =>
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
          /^https?:\/\//i.test(
            x.url
          )
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

EXACT CAREER:
${career}

DO NOT CHANGE THIS CAREER.

If the input contains a specialization,
keep that specialization central.

COUNTRY:
India

LIVE WEB EVIDENCE:
${evidence ||
"No usable live source was retrieved."}

Return ONLY one valid JSON object.

Use exactly:

{
  "career":"",
  "what_it_involves":"",
  "pros":[],
  "cons":[],
  "pay_india":"",
  "market_requirements":[],
  "demand":"",
  "future_growth":"",
  "step_by_step_path":[],
  "academic_education":[],
  "vocational_diploma":[],
  "certifications":[],
  "job_ready_skills":[],
  "alternatives":[],
  "barriers":[],
  "rewards":[],
  "public_discussion_themes":[],
  "student_fit":"",
  "family_concerns_addressed":[],
  "sources":[]
}

RULES:

1. Keep the exact career.
2. India first.
3. Prefer official Indian sources.
4. Never invent a source.
5. Never invent salary.
6. Never invent demand statistics.
7. Never invent regulations.
8. Explain uncertainty.
9. Do not turn search-result quantity into proof of demand.
10. For medical careers distinguish:
   MBBS
   registration
   postgraduate training
   advanced specialty training
11. Explain the actual pathway.
12. Give realistic barriers.
13. Give comparable alternatives.
14. Do not exaggerate future growth.
15. Public discussions are themes, not statistical evidence.
16. Do not make student-specific claims unless student data was supplied.
17. JSON ONLY.
`;
}


/* =========================================================
   RESEARCH NORMALIZATION
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

  d.career =
    career;

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
    const [
      key,
      list
    ] of Object.entries(
      aliases
    )
  ) {

    if (
      d[key] == null ||
      d[key] === ""
    ) {

      for (
        const alias of list
      ) {

        if (
          d[alias] != null &&
          d[alias] !== ""
        ) {

          d[key] =
            d[alias];

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

  for (
    const key of arrays
  ) {

    if (
      !Array.isArray(
        d[key]
      )
    ) {

      d[key] =
        d[key]
          ? [String(d[key])]
          : [];
    }
  }

  /*
   * NEVER expose URLs invented by the AI.
   * Only URLs retrieved by our search layer.
   */

  if (
    Array.isArray(sources) &&
    sources.length
  ) {

    d.sources =
      sources.map(
        source => ({
          title:
            cleanText(
              source.title
            ),

          url:
            cleanText(
              source.url
            ),

          snippet:
            cleanText(
              source.snippet
            ),

          why_relevant:
            "Live source retrieved for this career research."
        })
      );

  } else if (
    !d.sources.length
  ) {

    d.sources = [];
  }

  if (
    !d.what_it_involves
  ) {

    d.what_it_involves =
      `The ${career} role involves applying relevant knowledge and practical skills to solve problems and deliver useful outcomes.`;
  }

  if (
    !d.pay_india
  ) {

    d.pay_india =
      "Current India salary could not be reliably verified from the retrieved sources.";
  }

  if (
    !d.demand
  ) {

    d.demand =
      "Current demand could not be reliably verified from the retrieved sources.";
  }

  if (
    !d.future_growth
  ) {

    d.future_growth =
      "Future growth could not be reliably verified from the retrieved sources.";
  }

  return d;
}


/* =========================================================
   LAST-RESORT WEB FALLBACK
========================================================= */

function webFallbackResearch(
  career,
  sources
) {

  const usable =
    sources.slice(
      0,
      12
    );

  const sourceList =
    usable.map(
      source => ({
        title:
          source.title,

        url:
          source.url,

        snippet:
          source.snippet,

        why_relevant:
          "Retrieved as live evidence for this exact career in India."
      })
    );

  const text =
    usable
      .map(
        x =>
          `${x.title} ${x.snippet}`
      )
      .join(" ");

  const medical =
    /surgeon|doctor|physician|orthopedic|orthopaedic|cardio|neuro|radiolog|dermatolog|anesthes|anaesthes|patholog|pediatric|paediatric|oncolog|dentist/i.test(
      career
    );

  const spine =
    /spine|spinal/i.test(
      career
    );

  const path =
    medical
      ? [

          "Complete the required undergraduate medical education pathway in India, typically MBBS for a medical specialist career.",

          "Complete the applicable internship and registration requirements under the current Indian regulatory framework.",

          "Enter the relevant postgraduate specialty pathway through the applicable entrance and counselling process.",

          spine
            ? "After orthopaedic specialty training, build advanced spine expertise through appropriate supervised training or fellowship where applicable."
            : "Build supervised specialist clinical and procedural experience.",

          "Continue professional development and verify current credential and registration requirements."
        ]

      : [

          `Build the academic foundation required for ${career}.`,

          "Complete relevant higher education or professional training.",

          "Build practical skills through projects, supervised work or internships.",

          "Add relevant certifications only when they are genuinely useful for the target role.",

          "Gain experience and continue skill development."
        ];

  const education =
    medical
      ? [

          "Medical undergraduate education is the foundation for the specialist pathway.",

          "Postgraduate specialty training is normally required for specialist medical practice.",

          spine
            ? "Advanced spine-focused training may be pursued after the core orthopaedic pathway; exact requirements should be checked against current rules."
            : "Exact specialty qualification requirements should be verified against current Indian regulations and institutions."
        ]

      : [

          "The required academic qualification depends on the exact role and employer.",

          "Current course and employer requirements should be checked before choosing a programme."
        ];

  const requirements =
    usable
      .slice(
        0,
        8
      )
      .map(
        x =>
          `${x.title}${x.snippet ? ` — ${x.snippet}` : ""}`
      );

  const hasSalaryEvidence =
    /salary|lakh|lpa|₹|rs\.?\s?\d|inr/i.test(
      text
    );

  const hasTrainingEvidence =
    /mbbs|ms |dnb|fellowship|registration|nmc|nbems|residency/i.test(
      text
    );

  return normalizeResearch(

    {

      career,

      what_it_involves:
        medical
          ? `${career} is a specialist medical career involving patient assessment, diagnosis, treatment planning, procedures or surgery where applicable, follow-up and continued professional learning.`
          : `${career} involves applying the knowledge and practical skills specific to the role, solving real problems and delivering outcomes.`,

      pros:
        medical
          ? [
              "High level of specialised professional responsibility.",
              "Potential to make a direct impact on patient outcomes.",
              "Scope to build deep expertise."
            ]
          : [
              "Opportunity to develop specialised expertise.",
              "Potential for multiple employer or industry pathways.",
              "Scope for continued learning and progression."
            ],

      cons:
        medical
          ? [
              "Long and demanding training pathway.",
              "High responsibility.",
              "Workload and lifestyle can vary significantly by practice setting."
            ]
          : [
              "Competition varies by employer.",
              "Skills need to be updated as the field changes.",
              "Early-career outcomes can vary by location and employer."
            ],

      pay_india:
        hasSalaryEvidence
          ? "The retrieved results contain salary references, but exact figures should be interpreted according to experience, city, employer and practice type."
          : "No sufficiently reliable current India salary range was established from the retrieved sources.",

      market_requirements:
        requirements,

      demand:
        usable.length
          ? `Live India search results were found for ${career}. They show current activity, but search-result volume alone is not a national demand statistic.`
          : `No usable live India sources were retrieved for ${career}.`,

      future_growth:
        "Future growth depends on industry or healthcare demand, technology, employer needs and the ability to keep skills current.",

      step_by_step_path:
        path,

      academic_education:
        education,

      vocational_diploma:
        medical
          ? []
          : [
              "Vocational or diploma routes may be relevant only where they are accepted for the exact target role."
            ],

      certifications:
        medical
          ? [
              "Verify current registration and qualification requirements with the applicable Indian authority.",
              hasTrainingEvidence
                ? "Retrieved sources contain training or qualification references; verify the exact current pathway."
                : "No specific certification claim is made because evidence was insufficient."
            ]
          : [
              "Choose certifications that are genuinely relevant to the target job."
            ],

      job_ready_skills:
        medical
          ? [
              "Clinical assessment",
              "Decision-making",
              "Relevant procedural skills",
              "Patient communication",
              "Evidence-based practice",
              "Teamwork"
            ]
          : [
              "Role-specific technical skills",
              "Communication",
              "Problem solving",
              "Practical project evidence",
              "Interview and workplace skills"
            ],

      alternatives:
        medical
          ? [
              "Related specialist pathways",
              "Academic or teaching pathways",
              "Research pathways",
              "Adjacent hospital-based roles"
            ]
          : [],

      barriers:
        medical
          ? [
              "Long education and training timeline",
              "Competitive specialist training",
              "High professional responsibility",
              "Continuous learning"
            ]
          : [
              "Competition",
              "Need for demonstrable skills",
              "Changing technology"
            ],

      rewards:
        medical
          ? [
              "Specialist expertise",
              "Potential patient impact",
              "Professional growth",
              "Teaching or research opportunities"
            ]
          : [
              "Professional expertise",
              "Career progression",
              "Potential to work across organisations or industries"
            ],

      public_discussion_themes:
        [],

      student_fit:
        "Student-specific fit cannot safely be inferred from career research alone. CareerMitra should combine this research with Test Zone and Personal Vault evidence.",

      family_concerns_addressed:
        [],

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

function researchNeedsRepair(
  data
) {

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
    required.filter(
      key =>
        data[key] == null ||
        data[key] === "" ||
        (
          Array.isArray(
            data[key]
          ) &&
          data[key].length === 0
        )
    );

  return (
    missing.length >= 4
  );
}


/* =========================================================
   MAIN VERCEL HANDLER
========================================================= */

export default async function handler(
  req,
  res
) {

  if (
    req.method !== "POST"
  ) {

    return res.status(
      405
    ).json({

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

      return res.status(
        400
      ).json({

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
      extractCareer(
        prompt
      );


    /* =====================================================
       LIVE WEB RESEARCH
    ===================================================== */

    if (webSearch) {

      if (!career) {

        return res.status(
          400
        ).json({

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


      /*
       * Search queries run in parallel.
       * This is web search, not OpenRouter calls.
       */

      const groups =
        await Promise.all(
          queries.map(
            searchWeb
          )
        );


      const seen =
        new Set();


      const badCountry =
        /melbourne|florida|australia|canada|united states|new york|california|uk orthopedic surgeon jobs/i;


      sources =
        groups
          .flat()
          .filter(
            item => {

              if (
                !item.url ||
                seen.has(
                  item.url
                )
              ) {
                return false;
              }

              const combined =
                `${item.title} ${item.snippet}`;


              /*
               * Drop obvious foreign
               * local-service results.
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


              seen.add(
                item.url
              );

              return true;
            }
          )
          .sort(
            (a, b) =>
              sourcePriority(
                b.url
              ) -
              sourcePriority(
                a.url
              )
          )
          .slice(
            0,
            20
          );


      const evidence =
        sources
          .map(
            (source, index) =>
              `[SOURCE ${index + 1}]
TITLE: ${source.title}
URL: ${source.url}
SNIPPET: ${source.snippet}`
          )
          .join(
            "\n\n"
          );


      finalPrompt =
        researchPrompt(
          career,
          evidence
        );
    }


    /* =====================================================
       FIRST AI REQUEST
    ===================================================== */

    let ai;

    let usedFallback =
      false;


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
       * LIVE RESEARCH:
       * only after complete AI failure,
       * use source-backed recovery.
       */

      if (
        webSearch &&
        career &&
        sources.length
      ) {

        return res.status(
          200
        ).json({

          ok: true,

          ai: false,

          fallbackUsed:
            true,

          aiFailed:
            true,

          rateLimited:
            Number(
              error?.status
            ) === 429,

          retryAfter:
            error?.retryAfter ||
            null,

          data:
            webFallbackResearch(
              career,
              sources
            ),

          model:
            null,

          sources,

          warning:
            "Source-backed recovery was used only after the AI recovery chain failed."

        });
      }


      /*
       * Non-web AI failures should NOT
       * silently fabricate an answer.
       */

      const status =
        Number(
          error?.status ||
          503
        );


      return res.status(
        status === 429
          ? 429
          : 503
      ).json({

        ok: false,

        aiFailed:
          true,

        fallbackAllowed:
          true,

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

      if (
        !data ||
        researchNeedsRepair(
          data
        )
      ) {

        try {

          const repairPrompt =
            `${finalPrompt}

RECOVERY PASS:

The previous AI response was incomplete or malformed.

Rebuild the COMPLETE JSON object.

Keep the exact career.

Use the supplied evidence.

Do not invent information.

Fill every major section with useful,
career-specific information where evidence permits.

Clearly state uncertainty where evidence is weak.`;

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

        } catch (repairError) {

          console.error(
            "CareerMitra AI research repair failed",
            repairError
          );
        }
      }


      /*
       * ONLY NOW use deterministic fallback.
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
       FINAL RESPONSE
    ===================================================== */

    return res.status(
      200
    ).json({

      ok: true,

      ai:
        !usedFallback,

      fallbackUsed:
        usedFallback,

      data:
        data ||
        ai.text,

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


    return res.status(
      503
    ).json({

      ok: false,

      aiFailed:
        true,

      fallbackAllowed:
        true,

      error:
        cleanText(
          error?.message ||
          "AI service temporarily unavailable."
        )

    });
  }
}
