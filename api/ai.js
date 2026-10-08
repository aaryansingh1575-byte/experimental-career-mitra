// api/ai.js
// CareerMitra AI Backend
// AI-FIRST Test Zone
// Vercel Serverless Function

export const maxDuration = 60;

const OPENROUTER_URL =
  "https://openrouter.ai/api/v1/chat/completions";

const PRIMARY_MODEL =
  process.env.OPENROUTER_MODEL ||
  "nvidia/nemotron-3-ultra-550b-a55b:free";

const TEST_MODEL =
  process.env.OPENROUTER_TEST_MODEL ||
  PRIMARY_MODEL;

const FALLBACK_MODELS = [
  TEST_MODEL,
  PRIMARY_MODEL,
  "nvidia/nemotron-3.5-lightning:free",
  "nvidia/nemotron-3-super-120b-a12b:free",
  "openrouter/free"
].filter((v, i, a) => v && a.indexOf(v) === i);

const RETRYABLE_STATUS = new Set([
  408,
  409,
  425,
  429,
  500,
  502,
  503,
  504
]);


// ============================================================
// BASIC HELPERS
// ============================================================

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function clean(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function arr(value) {
  if (Array.isArray(value)) {
    return value
      .map(clean)
      .filter(Boolean);
  }

  if (typeof value === "string") {
    return value
      .split(/[,;\n]/)
      .map(clean)
      .filter(Boolean);
  }

  return [];
}

function unique(list) {
  return [...new Set(
    (list || [])
      .map(clean)
      .filter(Boolean)
  )];
}

function safeJsonParse(text) {
  if (!text) return null;

  let raw = String(text).trim();

  raw = raw
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  try {
    return JSON.parse(raw);
  } catch {}

  const first = raw.indexOf("{");
  const last = raw.lastIndexOf("}");

  if (first >= 0 && last > first) {
    try {
      return JSON.parse(raw.slice(first, last + 1));
    } catch {}
  }

  return null;
}


// ============================================================
// VAULT NORMALIZATION
// ============================================================

function normalizeVault(vault = {}) {
  return {
    interests: unique(
      arr(vault.interests ?? vault.interest)
    ),

    hobbies: unique(
      arr(vault.hobbies ?? vault.activities)
    ),

    likings: unique(
      arr(vault.likings ?? vault.likes)
    ),

    strongSubjects: unique(
      arr(
        vault.strongSubjects ??
        vault.subjects ??
        vault.strong_subjects
      )
    ),

    preferredRoles: unique(
      arr(
        vault.preferredRoles ??
        vault.roles ??
        vault.preferred_roles
      )
    ),

    nonNegotiable: clean(
      vault.nonNegotiable ??
      vault.nonnegotiable ??
      vault.non_negotiable
    ),

    chosenField: clean(
      vault.chosenField ??
      vault.field ??
      vault.chosen_field
    ),

    whyField: clean(
      vault.whyField ??
      vault.why_field
    ),

    whyNotOthers: clean(
      vault.whyNotOthers ??
      vault.why_not_others
    ),

    skills: unique(
      arr(
        vault.skills ??
        vault.verifiedSkills ??
        vault.verified_skills
      )
    ),

    stage: clean(
      vault.stage ??
      vault.educationStage ??
      ""
    )
  };
}


// ============================================================
// VAULT CONTEXT
// ============================================================

function vaultContext(vault) {
  const v = normalizeVault(vault);

  return {
    interests: v.interests,
    hobbies: v.hobbies,
    likings: v.likings,
    strongSubjects: v.strongSubjects,
    preferredRoles: v.preferredRoles,
    nonNegotiable: v.nonNegotiable,
    chosenField: v.chosenField,
    whyField: v.whyField,
    whyNotOthers: v.whyNotOthers,
    skills: v.skills,
    stage: v.stage
  };
}


// ============================================================
// TEST ZONE PROMPT
// ============================================================

function buildTestPrompt(vault) {
  const v = normalizeVault(vault);

  return `
You are the AI assessment engine for CareerMitra.

Your ONLY job in this request is to create a personalised career-counselling
questionnaire from the student's Personal Vault.

THIS MUST BE PERSONALISED.

The questions MUST be generated from the student's actual Vault data below.

Do NOT use a fixed question bank.

Do NOT return generic questions that could be shown to every student.

Two students with different Vaults MUST receive meaningfully different questions.

PERSONAL VAULT
===============

Interests:
${JSON.stringify(v.interests)}

Hobbies / Activities:
${JSON.stringify(v.hobbies)}

Likings:
${JSON.stringify(v.likings)}

Strong Subjects:
${JSON.stringify(v.strongSubjects)}

Preferred Roles:
${JSON.stringify(v.preferredRoles)}

Non-Negotiable Career:
${JSON.stringify(v.nonNegotiable)}

Chosen Field:
${JSON.stringify(v.chosenField)}

Why Chosen Field:
${JSON.stringify(v.whyField)}

Why Not Other Fields:
${JSON.stringify(v.whyNotOthers)}

Verified Skills:
${JSON.stringify(v.skills)}

Education Stage:
${JSON.stringify(v.stage)}


QUESTION DISTRIBUTION
=====================

Generate EXACTLY 25 questions.

Interests: 5
Hobbies / Activities: 4
Strong Subjects: 4
Career / Role Preferences: 5
Skills / Strengths: 4
Work Style / Personality: 3


PERSONALISATION RULE
====================

Every question must be grounded in the student's Vault.

For each question provide "basedOn".

"basedOn" must identify the actual Vault item(s) used to construct that
question.

Example:

Vault:
Strong Subjects = ["Physics", "Mathematics"]

Good:
"Between Physics and Mathematics, which type of problem do you enjoy
solving for a longer time?"

basedOn:
["Physics", "Mathematics"]

Bad:
"Do you enjoy problem solving?"

because that question could be given to everyone.


QUESTION QUALITY
================

Questions must:

1. Be neutral.
2. Not tell the student which answer is better.
3. Not push a particular career.
4. Not assume that the student's existing preference is correct.
5. Explore genuine preference.
6. Avoid repetition.
7. Use the student's actual Vault information.
8. Have exactly 4 answer options.
9. Have four meaningfully different options.
10. Avoid "All of the above".
11. Avoid "None of the above".
12. Avoid obviously correct answers.
13. Avoid leading language.
14. Avoid saying "Since you like X, you should..."
15. Do not mention that the AI is analysing the student.
16. Do not directly reveal scoring logic.

WORK-STYLE / PERSONALITY QUESTIONS
==================================

Personality questions may use the student's Vault as context.

They should explore dimensions such as:

- analytical vs intuitive
- structured vs flexible
- individual vs collaborative
- practical vs theoretical
- stable vs uncertain environments
- deep-specialisation vs variety

But do NOT force the student into one personality type.


TRAIT MAP
=========

Every question must include:

traitMap: {
  R: number,
  I: number,
  A: number,
  S: number,
  E: number,
  C: number
}

Each value must be between 0 and 2.

The values represent how strongly an option relates to that Holland/RIASEC
dimension.

Keep the scoring subtle and do not make one option obviously superior.


OUTPUT
======

Return ONLY valid JSON.

Schema:

{
  "questions": [
    {
      "id": 1,
      "category": "Interests",
      "question": "...",
      "options": [
        "...",
        "...",
        "...",
        "..."
      ],
      "basedOn": [
        "actual Vault item"
      ],
      "traitMap": {
        "R": 0,
        "I": 0,
        "A": 0,
        "S": 0,
        "E": 0,
        "C": 0
      }
    }
  ]
}

Exactly 25 questions.
No markdown.
No explanation outside JSON.
`;
}


// ============================================================
// TEST VALIDATION
// ============================================================

const REQUIRED_CATEGORIES = {
  "Interests": 5,
  "Hobbies / Activities": 4,
  "Strong Subjects": 4,
  "Career / Role Preferences": 5,
  "Skills / Strengths": 4,
  "Work Style / Personality": 3
};

function normalizeCategory(category) {
  const c = clean(category).toLowerCase();

  if (c.includes("interest"))
    return "Interests";

  if (
    c.includes("hobby") ||
    c.includes("activity")
  )
    return "Hobbies / Activities";

  if (
    c.includes("subject") ||
    c.includes("academic")
  )
    return "Strong Subjects";

  if (
    c.includes("career") ||
    c.includes("role")
  )
    return "Career / Role Preferences";

  if (
    c.includes("skill") ||
    c.includes("strength")
  )
    return "Skills / Strengths";

  if (
    c.includes("personality") ||
    c.includes("work style")
  )
    return "Work Style / Personality";

  return "";
}


// ============================================================
// SEMANTIC VAULT GROUNDING
// ============================================================

function tokens(text) {
  return clean(text)
    .toLowerCase()
    .replace(/[^a-z0-9+#.\s-]/g, " ")
    .split(/\s+/)
    .filter(x => x.length >= 3);
}

function similarity(a, b) {
  const A = new Set(tokens(a));
  const B = new Set(tokens(b));

  if (!A.size || !B.size) return 0;

  let overlap = 0;

  for (const x of A) {
    if (B.has(x)) overlap++;
  }

  return overlap / Math.max(1, Math.min(A.size, B.size));
}

function vaultItemsForCategory(v, category) {
  switch (category) {
    case "Interests":
      return [
        ...v.interests,
        ...v.likings
      ];

    case "Hobbies / Activities":
      return [
        ...v.hobbies,
        ...v.likings
      ];

    case "Strong Subjects":
      return [
        ...v.strongSubjects
      ];

    case "Career / Role Preferences":
      return [
        ...v.preferredRoles,
        v.nonNegotiable,
        v.chosenField
      ].filter(Boolean);

    case "Skills / Strengths":
      return [
        ...v.skills,
        ...v.strongSubjects
      ];

    case "Work Style / Personality":
      return [
        ...v.interests,
        ...v.hobbies,
        ...v.preferredRoles,
        ...v.skills,
        ...v.strongSubjects
      ];

    default:
      return [];
  }
}

function isGrounded(question, basedOn, vault, category) {
  const categoryItems = vaultItemsForCategory(
    vault,
    category
  );

  const references = unique([
    ...arr(basedOn),
    ...categoryItems
  ]);

  const q = clean(question);

  if (!q) return false;

  // Strong direct grounding.
  for (const item of categoryItems) {
    if (
      item.length >= 3 &&
      (
        q.toLowerCase().includes(item.toLowerCase()) ||
        similarity(q, item) >= 0.34
      )
    ) {
      return true;
    }
  }

  // AI may put the grounding in basedOn.
  for (const item of arr(basedOn)) {
    if (
      categoryItems.some(
        actual =>
          similarity(item, actual) >= 0.45 ||
          clean(item).toLowerCase() ===
          clean(actual).toLowerCase()
      )
    ) {
      return true;
    }
  }

  // Work-style questions can legitimately synthesize several Vault signals.
  if (
    category === "Work Style / Personality" &&
    references.length >= 2
  ) {
    return references.some(
      x => similarity(q, x) >= 0.22
    );
  }

  return false;
}


function validateTraitMap(map) {
  if (!map || typeof map !== "object") {
    return false;
  }

  const keys = ["R", "I", "A", "S", "E", "C"];

  return keys.every(key => {
    const n = Number(map[key]);

    return (
      Number.isFinite(n) &&
      n >= 0 &&
      n <= 2
    );
  });
}


function validateQuestion(question, vault) {
  const issues = [];

  if (!question || typeof question !== "object") {
    return ["question is not an object"];
  }

  const category =
    normalizeCategory(question.category);

  if (!category) {
    issues.push("invalid category");
  }

  if (!clean(question.question)) {
    issues.push("missing question");
  }

  const options = arr(question.options);

  if (options.length !== 4) {
    issues.push("must have exactly 4 options");
  }

  if (
    unique(options.map(x => x.toLowerCase())).length !== 4
  ) {
    issues.push("options must be unique");
  }

  if (!arr(question.basedOn).length) {
    issues.push("missing basedOn");
  }

  if (!validateTraitMap(question.traitMap)) {
    issues.push("invalid traitMap");
  }

  if (
    category &&
    !isGrounded(
      question.question,
      question.basedOn,
      vault,
      category
    )
  ) {
    issues.push(
      "question is not sufficiently grounded in the Personal Vault"
    );
  }

  // Obvious leading / biased phrasing.
  const q = clean(question.question).toLowerCase();

  const bannedPatterns = [
    "obviously",
    "clearly the best",
    "correct answer",
    "right career",
    "ideal career",
    "best career",
    "you should choose",
    "since you like",
    "therefore you should",
    "which career should you definitely"
  ];

  if (
    bannedPatterns.some(
      p => q.includes(p)
    )
  ) {
    issues.push("leading or biased wording");
  }

  return issues;
}


// ============================================================
// STRICT COMPLETE TEST VALIDATION
// ============================================================

function validateTestPayload(data, vault) {
  const errors = [];

  if (!data || !Array.isArray(data.questions)) {
    return {
      valid: false,
      errors: ["missing questions array"]
    };
  }

  if (data.questions.length !== 25) {
    errors.push(
      `expected 25 questions, received ${data.questions.length}`
    );
  }

  const counts = {};

  for (const q of data.questions) {
    const category =
      normalizeCategory(q?.category);

    if (category) {
      counts[category] =
        (counts[category] || 0) + 1;
    }

    const qErrors =
      validateQuestion(q, vault);

    if (qErrors.length) {
      errors.push(
        `Q${q?.id ?? "?"}: ${qErrors.join(", ")}`
      );
    }
  }

  for (const [category, required] of Object.entries(
    REQUIRED_CATEGORIES
  )) {
    if ((counts[category] || 0) !== required) {
      errors.push(
        `${category}: expected ${required}, got ${
          counts[category] || 0
        }`
      );
    }
  }

  // Questions themselves must be sufficiently different.
  const normalizedQuestions =
    data.questions.map(q =>
      clean(q?.question).toLowerCase()
    );

  const duplicates = new Set();

  for (let i = 0; i < normalizedQuestions.length; i++) {
    for (let j = i + 1; j < normalizedQuestions.length; j++) {
      const a = normalizedQuestions[i];
      const b = normalizedQuestions[j];

      if (
        a &&
        b &&
        (
          a === b ||
          similarity(a, b) >= 0.82
        )
      ) {
        duplicates.add(`${i + 1}-${j + 1}`);
      }
    }
  }

  if (duplicates.size) {
    errors.push(
      `duplicate/similar questions: ${[
        ...duplicates
      ].join(", ")}`
    );
  }

  return {
    valid: errors.length === 0,
    errors
  };
}


// ============================================================
// OPENROUTER REQUEST
// ============================================================

async function requestAI({
  prompt,
  system = "",
  modelList = FALLBACK_MODELS,
  maxAttempts = 3
}) {
  const apiKey =
    process.env.OPENROUTER_API_KEY;

  if (!apiKey) {
    throw new Error(
      "OPENROUTER_API_KEY is missing"
    );
  }

  let lastError = null;

  for (
    let attempt = 0;
    attempt < maxAttempts;
    attempt++
  ) {
    const model =
      modelList[
        attempt % modelList.length
      ];

    try {
      const response = await fetch(
        OPENROUTER_URL,
        {
          method: "POST",

          headers: {
            "Authorization":
              `Bearer ${apiKey}`,

            "Content-Type":
              "application/json",

            "HTTP-Referer":
              process.env.APP_URL ||
              "https://careermitra.vercel.app",

            "X-Title":
              "CareerMitra"
          },

          body: JSON.stringify({
            model,

            messages: [
              {
                role: "system",
                content:
                  system ||
                  "You are a careful career counselling AI. Return exactly the requested JSON."
              },
              {
                role: "user",
                content: prompt
              }
            ],

            temperature: 0.75,

            max_tokens: 7000,

            provider: {
              allow_fallbacks: true
            },

            response_format: {
              type: "json_object"
            }
          })
        }
      );

      const text =
        await response.text();

      if (!response.ok) {
        lastError =
          new Error(
            `OpenRouter ${response.status}: ${text.slice(
              0,
              500
            )}`
          );

        if (
          RETRYABLE_STATUS.has(
            response.status
          )
        ) {
          await sleep(
            300 * (attempt + 1)
          );
          continue;
        }

        throw lastError;
      }

      const json =
        safeJsonParse(text);

      const content =
        json?.choices?.[0]?.message?.content;

      if (!content) {
        lastError =
          new Error(
            "AI returned empty content"
          );

        await sleep(
          300 * (attempt + 1)
        );

        continue;
      }

      return {
        text: content,
        model,
        attempt: attempt + 1
      };

    } catch (error) {
      lastError = error;

      if (attempt < maxAttempts - 1) {
        await sleep(
          300 * (attempt + 1)
        );
      }
    }
  }

  throw lastError ||
    new Error("AI request failed");
}


// ============================================================
// AI TEST GENERATION
// ============================================================

async function generateTest(vault) {
  const prompt =
    buildTestPrompt(vault);

  const first =
    await requestAI({
      prompt,
      modelList: FALLBACK_MODELS,
      maxAttempts: 3
    });

  let data =
    safeJsonParse(first.text);

  let validation =
    validateTestPayload(
      data,
      normalizeVault(vault)
    );

  if (validation.valid) {
    return {
      data,
      aiGenerated: true,
      repaired: false,
      model: first.model,
      attempts: first.attempt
    };
  }


  // ========================================================
  // AI REPAIR
  // ========================================================

  const repairPrompt = `
The previous AI-generated CareerMitra Test Zone output
was structurally or semantically invalid.

DO NOT create a generic questionnaire.

REGENERATE the complete 25-question test using the SAME
Personal Vault.

The questions MUST remain personalised to the Vault.

VALIDATION ERRORS:
${JSON.stringify(validation.errors, null, 2)}

PERSONAL VAULT:
${JSON.stringify(
  vaultContext(vault),
  null,
  2
)}

Required distribution:

Interests: 5
Hobbies / Activities: 4
Strong Subjects: 4
Career / Role Preferences: 5
Skills / Strengths: 4
Work Style / Personality: 3

Every question needs:

id
category
question
exactly 4 options
basedOn
traitMap with R,I,A,S,E,C from 0 to 2

"basedOn" MUST reference actual Vault information.

Do not copy a fixed question bank.

Do not return any explanation.

Return ONLY JSON:

{
  "questions": [...]
}
`;

  const repaired =
    await requestAI({
      prompt: repairPrompt,
      modelList: FALLBACK_MODELS,
      maxAttempts: 2
    });

  data =
    safeJsonParse(
      repaired.text
    );

  validation =
    validateTestPayload(
      data,
      normalizeVault(vault)
    );

  if (validation.valid) {
    return {
      data,
      aiGenerated: true,
      repaired: true,
      model: repaired.model,
      attempts:
        first.attempt +
        repaired.attempt
    };
  }

  const error =
    new Error(
      "AI generated invalid Test Zone output"
    );

  error.code =
    "INVALID_AI_TEST";

  error.validation =
    validation.errors;

  throw error;
}


// ============================================================
// LAST-RESORT FALLBACK
// ============================================================

function emergencyFallback(vault) {
  const v =
    normalizeVault(vault);

  const interest =
    v.interests[0] ||
    v.likings[0] ||
    "your interests";

  const subject =
    v.strongSubjects[0] ||
    "your strongest subject";

  const hobby =
    v.hobbies[0] ||
    "your favourite activity";

  const role =
    v.preferredRoles[0] ||
    v.nonNegotiable ||
    "your preferred career";

  const skill =
    v.skills[0] ||
    "one of your skills";

  const make = (
    id,
    category,
    question,
    options,
    basedOn
  ) => ({
    id,
    category,
    question,
    options,
    basedOn,
    traitMap: {
      R: 0,
      I: 1,
      A: 0,
      S: 0,
      E: 0,
      C: 1
    }
  });

  const questions = [];

  // This is deliberately only an emergency safety net.
  // It is NOT presented as AI-generated.

  for (let i = 0; i < 5; i++) {
    questions.push(
      make(
        questions.length + 1,
        "Interests",
        `When exploring ${interest}, which activity would you be most interested in trying?`,
        [
          "Understanding how it works",
          "Creating something related to it",
          "Discussing it with others",
          "Applying it to a practical problem"
        ],
        [interest]
      )
    );
  }

  for (let i = 0; i < 4; i++) {
    questions.push(
      make(
        questions.length + 1,
        "Hobbies / Activities",
        `What part of ${hobby} do you find most engaging?`,
        [
          "Planning it",
          "Doing it hands-on",
          "Improving your technique",
          "Sharing it with others"
        ],
        [hobby]
      )
    );
  }

  for (let i = 0; i < 4; i++) {
    questions.push(
      make(
        questions.length + 1,
        "Strong Subjects",
        `When working with ${subject}, which type of task do you prefer?`,
        [
          "Learning the concepts",
          "Solving difficult problems",
          "Applying the concepts",
          "Explaining the concepts"
        ],
        [subject]
      )
    );
  }

  for (let i = 0; i < 5; i++) {
    questions.push(
      make(
        questions.length + 1,
        "Career / Role Preferences",
        `When considering ${role}, which aspect would matter most to you?`,
        [
          "Nature of the work",
          "Learning opportunities",
          "Long-term growth",
          "Work environment"
        ],
        [role]
      )
    );
  }

  for (let i = 0; i < 4; i++) {
    questions.push(
      make(
        questions.length + 1,
        "Skills / Strengths",
        `How would you prefer to use ${skill} in your future work?`,
        [
          "Solve practical problems",
          "Build new things",
          "Help other people",
          "Analyse complex situations"
        ],
        [skill]
      )
    );
  }

  for (let i = 0; i < 3; i++) {
    questions.push(
      make(
        questions.length + 1,
        "Work Style / Personality",
        `When working on something connected with ${interest}, which environment suits you best?`,
        [
          "Independent and focused",
          "Collaborative and interactive",
          "Structured and planned",
          "Flexible and experimental"
        ],
        [interest]
      )
    );
  }

  return {
    questions
  };
}


// ============================================================
// OTHER AI PURPOSES
// ============================================================

function genericPrompt(prompt) {
  return `
You are CareerMitra's AI career counselling engine.

Be neutral, evidence-based and student-specific.

Do not force a career choice.

Do not invent facts.

Return valid JSON only.

USER REQUEST:
${prompt}
`;
}


// ============================================================
// HANDLER
// ============================================================

export default async function handler(req, res) {

  if (req.method !== "POST") {
    return res.status(405).json({
      ok: false,
      error: "Method not allowed"
    });
  }

  try {

    const body =
      req.body || {};

    const prompt =
      clean(body.prompt);

    const purpose =
      clean(body.purpose).toLowerCase();

    const vault =
      body.vault ||
      body.personalVault ||
      null;


    // ========================================================
    // TEST ZONE
    // ========================================================

    const isTest =
      purpose === "test" ||
      purpose === "testzone" ||
      purpose === "test_zone" ||
      body.testZone === true ||
      /personal vault|25 questions|test zone/i.test(
        prompt
      );

    if (isTest) {

      if (!vault) {
        return res.status(400).json({
          ok: false,
          error:
            "Personal Vault is required for Test Zone generation."
        });
      }

      try {

        const result =
          await generateTest(
            vault
          );

        return res.status(200).json({
          ok: true,
          data: result.data,
          aiGenerated: true,
          fallbackUsed: false,
          repaired: result.repaired,
          model: result.model,
          attempts: result.attempts
        });

      } catch (error) {

        // ====================================================
        // ONLY HERE DOES EMERGENCY FALLBACK HAPPEN
        // ====================================================

        console.error(
          "TEST ZONE AI FAILURE:",
          error
        );

        const fallback =
          emergencyFallback(
            vault
          );

        return res.status(200).json({
          ok: true,

          data: fallback,

          aiGenerated: false,

          fallbackUsed: true,

          fallbackReason:
            error?.code ||
            error?.message ||
            "AI unavailable",

          warning:
            "Emergency built-in fallback used."
        });
      }
    }


    // ========================================================
    // NORMAL AI REQUEST
    // ========================================================

    if (!prompt) {
      return res.status(400).json({
        ok: false,
        error: "Prompt is required"
      });
    }

    const result =
      await requestAI({
        prompt:
          genericPrompt(prompt),

        modelList:
          FALLBACK_MODELS,

        maxAttempts: 3
      });

    const data =
      safeJsonParse(
        result.text
      );

    if (!data) {
      return res.status(502).json({
        ok: false,
        error:
          "AI returned invalid JSON"
      });
    }

    return res.status(200).json({
      ok: true,
      data,
      aiGenerated: true,
      fallbackUsed: false,
      model: result.model,
      attempts: result.attempt
    });

  } catch (error) {

    console.error(
      "CareerMitra AI ERROR:",
      error
    );

    return res.status(503).json({
      ok: false,
      error:
        error?.message ||
        "AI service temporarily unavailable",

      fallbackAllowed: true
    });
  }
}
