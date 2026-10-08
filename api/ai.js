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
].filter(
  (v, i, a) =>
    v && a.indexOf(v) === i
);


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

  const a = s.indexOf("{");
  const b = s.lastIndexOf("}");

  if (a >= 0 && b > a) {
    try {
      return JSON.parse(
        s.slice(a, b + 1)
      );
    } catch (_) {}
  }

  const x = s.indexOf("[");
  const y = s.lastIndexOf("]");

  if (x >= 0 && y > x) {
    try {
      return JSON.parse(
        s.slice(x, y + 1)
      );
    } catch (_) {}
  }

  return null;
}

function extractText(data) {
  const c =
    data?.choices?.[0];

  if (
    typeof c?.message?.content ===
    "string"
  ) {
    return c.message.content.trim();
  }

  if (
    Array.isArray(
      c?.message?.content
    )
  ) {
    return c.message.content
      .map(x =>
        typeof x === "string"
          ? x
          : x?.text || ""
      )
      .join("")
      .trim();
  }

  if (
    typeof c?.text === "string"
  ) {
    return c.text.trim();
  }

  return "";
}

function purposeFor(
  prompt,
  webSearch
) {
  const p =
    String(prompt || "")
      .toLowerCase();

  if (webSearch)
    return "live career research";

  if (
    /common ground|both sides|family concerns|student test analysis|decision-support analyst/
      .test(p)
  ) {
    return "common-ground analysis";
  }

  if (
    /parent|family|sincere|specific|relevant response|concern/
      .test(p)
  ) {
    return "family question/answer analysis";
  }

  if (
    /complete test|question plan|holland|personal vault|multiple-choice questions/
      .test(p)
  ) {
    return "student test generation";
  }

  if (
    /personality-and-interest test|holland-code tallies|career counsellor/
      .test(p)
  ) {
    return "student test answer analysis";
  }

  return "career counselling";
}


/* =========================================================
   OPENROUTER AI
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
    purposeFor(
      prompt,
      webSearch
    );

  const system = `
You are CareerMitra's ${purpose} engine.

Your job is to produce a HIGH-QUALITY,
useful result for a real student.

RETURN ONLY VALID JSON.

Never return:
- markdown
- code fences
- commentary outside JSON
- explanations outside JSON

GENERAL RULES:

1. Use supplied student/family information exactly.
2. Never invent personal facts.
3. For live career research, keep the EXACT career.
4. Never replace a specialization with a broader career.
5. Never invent:
   - source URLs
   - salary numbers
   - qualifications
   - regulations
   - statistics
   - demand claims
6. Prefer India-specific information.
7. Give concrete information instead of filler.
8. If evidence is weak, explain the limitation clearly.
9. Do not silently omit important requested sections.

${
  webSearch
    ? `
LIVE RESEARCH RULES:

- Use the web evidence supplied by CareerMitra.
- Cross-check important claims whenever possible.
- Prefer:
  * Indian government sources
  * NMC
  * NBEMS/NBME
  * MCC
  * AIIMS
  * Indian universities
  * established Indian hospitals
  * reputable Indian job portals
- Never treat one job listing as proof of national demand.
- Never treat search-result count as market size.
- Salary must include experience/location/employer context.
- For medical careers distinguish:
  * undergraduate education
  * registration
  * postgraduate specialty training
  * advanced fellowship/subspecialty training
- If the career is a specialist/subspecialist career,
  explain the actual pathway instead of giving generic advice.
`
    : ""
}

${
  repair
    ? `
RECOVERY PASS:

The previous AI response was incomplete,
malformed, or missing important sections.

Rebuild the COMPLETE JSON.

Do NOT shorten the answer.
Do NOT omit sections.
Use the original evidence and request.
`
    : ""
}
`;

  /*
   * OpenRouter handles model/provider failover.
   *
   * We intentionally DO NOT repeatedly hammer 429.
   * Account-level rate limits cannot be fixed by
   * repeatedly sending the same request.
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
        () =>
          controller.abort(),
        timeoutMs
      );

    try {
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
                model:
                  PRIMARY_MODEL,

                models:
                  FALLBACK_MODELS,

                messages: [
                  {
                    role: "system",
                    content:
                      system
                  },
                  {
                    role: "user",
                    content:
                      prompt
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
                  allow_fallbacks:
                    true,

                  sort:
                    "throughput"
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
          ) || null;

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
          PRIMARY_MODEL,

        attempts:
          attempt
      };

    } catch (error) {
      lastError =
        error;

      const status =
        Number(
          error?.status || 0
        );

      /*
       * DO NOT retry 429 immediately.
       * If the account is rate limited,
       * another immediate request usually
       * does not solve it.
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
        attempt <
          maxAttempts &&
        retryable
      ) {
        const wait =
          Math.min(
            1200,
            350 * attempt
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
   CAREER EXTRACTION
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
    const m =
      p.match(re);

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

function sourcePriority(
  url
) {
  const u =
    String(url || "")
      .toLowerCase();

  let score = 20;

  if (
    u.includes("nmc.org.in")
  )
    score = 120;

  else if (
    u.includes("natboard.edu.in")
  )
    score = 118;

  else if (
    u.includes("nbe.edu.in")
  )
    score = 118;

  else if (
    u.includes("mcc.nic.in")
  )
    score = 116;

  else if (
    u.includes("aiimsexams.ac.in")
  )
    score = 114;

  else if (
    u.includes("aiims.edu")
  )
    score = 112;

  else if (
    u.includes(".gov.in")
  )
    score = 100;

  else if (
    u.includes(".ac.in")
  )
    score = 90;

  else if (
    u.includes("apollohospitals.com")
  )
    score = 95;

  else if (
    u.includes("fortishealthcare.com")
  )
    score = 93;

  else if (
    u.includes("maxhealthcare.in")
  )
    score = 93;

  else if (
    u.includes("medanta.org")
  )
    score = 93;

  else if (
    u.includes("in.indeed.com")
  )
    score = 88;

  else if (
    u.includes("naukri.com")
  )
    score = 82;

  else if (
    u.includes("linkedin.com")
  )
    score = 70;

  else if (
    u.includes("who.int")
  )
    score = 65;

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
      encodeURIComponent(
        query
      );

    const r =
      await fetch(
        url,
        {
          headers: {
            "User-Agent":
              "Mozilla/5.0 CareerMitra/1.0"
          }
        }
      );

    if (!r.ok)
      return [];

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
          title:
            clean(title),

          url:
            clean(link),

          snippet:
            clean(snippet)
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
You are CareerMitra's senior
India-focused career research analyst.

EXACT CAREER TO RESEARCH:
${career}

DO NOT CHANGE THIS CAREER.

If the input contains a specialization,
that specialization MUST remain central.

COUNTRY:
India

LIVE WEB EVIDENCE:
${evidence ||
"No usable live source was retrieved."}

Return ONLY ONE valid JSON object.

Use exactly these keys:

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

QUALITY REQUIREMENTS:

1. EXACT CAREER

Do not substitute a nearby career.

Example:

If career =
"orthopedic surgeon with spine speciality"

then keep spine specialization
central throughout the response.

Do NOT turn it into:
- generic doctor
- generic surgeon
- generic orthopedic surgeon

2. INDIA FIRST

Prefer:

- NMC
- NBEMS
- MCC
- AIIMS
- Indian government sources
- Indian universities
- established Indian hospitals
- reputable India job portals

3. MEDICAL PATHWAY

Where applicable explain separately:

MBBS
↓
Registration/internship
↓
Relevant postgraduate specialty
↓
Advanced spine/subspecialty training
↓
Practice / further specialization

Do NOT claim a fellowship is legally mandatory
unless the evidence actually supports that claim.

4. PAY

Never invent precise salary.

If reliable evidence exists:
explain approximate range/context.

Mention:
- experience
- city
- employer
- government/private
- practice type

5. DEMAND

Do NOT say:

"Very high demand"

just because some jobs exist.

Explain:
- what evidence exists
- what evidence does not exist
- location/employer differences

6. MARKET REQUIREMENTS

Give actual:

- education
- qualifications
- registration
- skills
- experience
- employer expectations

7. PATH

Give a practical student-friendly
step-by-step pathway.

8. ALTERNATIVES

Give genuinely comparable alternatives.

Do NOT give random lower-level jobs.

9. PUBLIC DISCUSSION

Summarize recurring discussion themes.

Do NOT present forums as statistical evidence.

10. SOURCES

Only use URLs contained in
the supplied evidence.

NEVER manufacture URLs.

11. COMPLETENESS

Do not leave major fields empty.

Use reliable professional knowledge
for stable facts.

Clearly mark things that could not
be verified from current evidence.

12. NO FILLER

Do not write generic filler such as:

"opportunities should be evaluated"

when the evidence can provide
a more useful answer.

13. JSON ONLY.

No markdown.
No explanation.
No code fences.
`;
}


/* =========================================================
   NORMALIZE RESEARCH
========================================================= */

function normalizeResearch(
  data,
  career,
  sources
) {
  const d =
    data &&
    typeof data ===
      "object"
      ? {
          ...data
        }
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
        const a of list
      ) {
        if (
          d[a] != null &&
          d[a] !== ""
        ) {
          d[key] =
            d[a];

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
    const k of arrays
  ) {
    if (
      !Array.isArray(
        d[k]
      )
    ) {
      d[k] =
        d[k]
          ? [String(d[k])]
          : [];
    }
  }

  /*
   * VERY IMPORTANT:
   *
   * Never trust URLs invented by the AI.
   * Only expose URLs actually retrieved
   * by CareerMitra's live search.
   */

  if (
    Array.isArray(
      sources
    ) &&
    sources.length
  ) {
    d.sources =
      sources.map(
        x => ({
          title:
            cleanText(
              x.title
            ),

          url:
            cleanText(
              x.url
            ),

          snippet:
            cleanText(
              x.snippet
            ),

          why_relevant:
            "Live source retrieved for this exact career research."
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
   WORST-CASE FALLBACK
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
      x => ({
        title:
          x.title,

        url:
          x.url,

        snippet:
          x.snippet,

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
    /surgeon|doctor|physician|orthopedic|orthopaedic|cardio|neuro|radiolog|dermatolog|anesthes|anaesthes|patholog|pediatric|paediatric|oncolog|dentist/i
      .test(
        career
      );

  const spine =
    /spine|spinal/i.test(
      career
    );

  /*
   * THIS IS LAST RESORT ONLY.
   *
   * It should never pretend to be AI.
   */

  const path =
    medical
      ? [
          "Complete the required undergraduate medical education pathway in India, typically MBBS for a medical specialist career.",

          "Complete the applicable internship and registration requirements under the current Indian regulatory framework.",

          "Enter the relevant postgraduate specialty pathway through the currently applicable entrance and counselling process.",

          spine
            ? "After orthopaedic specialty training, build advanced spine expertise through appropriate supervised training or fellowship where applicable."
            : "Build supervised specialist clinical and procedural experience.",

          "Continue professional development, evidence-based practice and applicable registration or credential requirements."
        ]
      : [
          `Build the academic foundation required for ${career}.`,

          "Complete the relevant higher education or professional training pathway.",

          "Build practical skills through projects, supervised work or internships where applicable.",

          "Add relevant certifications only when they are genuinely valued for the target role.",

          "Gain experience and continue skill development as the market changes."
        ];

  const education =
    medical
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
      .test(
        text
      );

  const hasTrainingEvidence =
    /mbbs|ms |dnb|fellowship|registration|nmc|nbems|residency/i
      .test(
        text
      );

  return normalizeResearch(
    {
      career,

      what_it_involves:
        medical
          ? `${career} is a specialist medical career involving patient assessment, diagnosis, treatment planning, procedures or surgery where applicable, follow-up and continued professional learning. The exact scope depends on specialist training and practice setting.`
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

      public_discussion_themes:
        [],

      student_fit:
        "Student-specific fit cannot be safely inferred from career research alone. CareerMitra should combine this research with the student's Test Zone and Personal Vault data.",

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
    typeof data !==
      "object"
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
      k =>
        data[k] == null ||
        data[k] === "" ||
        (
          Array.isArray(
            data[k]
          ) &&
          data[k].length === 0
        )
    );

  /*
   * A response missing many sections
   * is considered incomplete.
   */

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
      typeof req.body ===
      "string"
        ? JSON.parse(
            req.body ||
              "{}"
          )
        : (
            req.body ||
            {}
          );

    const prompt =
      cleanText(
        body.prompt
      );

    const webSearch =
      body.webSearch ===
      true;

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
       LIVE CAREER RESEARCH
    ===================================================== */

    if (
      webSearch
    ) {
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

      const groups =
        await Promise.all(
          queries.map(
            searchWeb
          )
        );

      const seen =
        new Set();

      /*
       * Remove obvious foreign local-service
       * results.
       */

      const badCountry =
        /melbourne|florida|australia|canada|united states|new york|california|uk orthopedic surgeon jobs/i;

      sources =
        groups
          .flat()
          .filter(
            x => {

              if (
                !x.url ||
                seen.has(
                  x.url
                )
              ) {
                return false;
              }

              const combined =
                `${x.title} ${x.snippet}`;

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
                x.url
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
            (x, i) =>
              `[SOURCE ${i + 1}]
TITLE: ${x.title}
URL: ${x.url}
SNIPPET: ${x.snippet}`
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
       PRIMARY AI REQUEST
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

    } catch (
      error
    ) {

      console.error(
        "CareerMitra AI request failed",
        error
      );

      /*
       * ONLY AFTER THE AI CHAIN FAILS
       * do we activate the source-backed
       * emergency fallback.
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
       PARSE AI JSON
    ===================================================== */

    let data =
      parseJSON(
        ai.text
      );


    /* =====================================================
       AI RECOVERY PASS
    ===================================================== */

    if (
      webSearch
    ) {

      /*
       * AI succeeded at HTTP level,
       * but may have returned malformed/
       * incomplete JSON.
       *
       * DO NOT immediately use fallback.
       *
       * Give AI another dedicated repair pass.
       */

      if (
        !data ||
        researchNeedsRepair(
          data
        )
      ) {

        try {

          const repairPrompt =
            `${finalPrompt}

RECOVERY INSTRUCTION:

The previous response was incomplete or malformed.

Rebuild the COMPLETE JSON object now.

Every major section must contain useful,
career-specific information grounded in
the supplied evidence.

Do NOT omit sections merely because
one source is weak.

Do NOT replace the exact career.

Return JSON ONLY.`;

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


      /* ===================================================
         FINAL NORMALIZATION
      =================================================== */

      if (
        data
      ) {

        data =
          normalizeResearch(
            data,
            career,
            sources
          );

      } else {

        /*
         * TRUE LAST RESORT.
         *
         * This is the only place where
         * deterministic research fallback
         * is allowed after AI failure.
         */

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
       RESPONSE
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

  } catch (
    error
  ) {

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
