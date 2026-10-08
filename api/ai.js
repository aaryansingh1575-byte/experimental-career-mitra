// api/ai.js

export const maxDuration = 60;

const OPENROUTER_URL =
  "https://openrouter.ai/api/v1/chat/completions";

const MODELS = [
  process.env.OPENROUTER_MODEL ||
    "nvidia/nemotron-3-ultra-550b-a55b:free",
  "nvidia/nemotron-3.5-lightning:free",
  "nvidia/nemotron-3-super-120b-a12b:free",
  "openrouter/free"
].filter((m, i, a) => m && a.indexOf(m) === i);

const RETRYABLE = new Set([
  408,
  409,
  425,
  429,
  500,
  502,
  503,
  504
]);

const sleep = ms =>
  new Promise(resolve => setTimeout(resolve, ms));

function extractText(data) {
  if (!data) return "";

  if (
    typeof data.output_text === "string" &&
    data.output_text.trim()
  ) {
    return data.output_text.trim();
  }

  const content =
    data?.choices?.[0]?.message?.content;

  if (typeof content === "string") {
    return content.trim();
  }

  if (Array.isArray(content)) {
    return content
      .map(x =>
        typeof x === "string"
          ? x
          : x?.text || ""
      )
      .join("")
      .trim();
  }

  return "";
}

function parseJSON(text) {
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {}

  const fenced = text.match(
    /```(?:json)?\s*([\s\S]*?)```/i
  );

  if (fenced) {
    try {
      return JSON.parse(
        fenced[1].trim()
      );
    } catch {}
  }

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");

  if (start !== -1 && end > start) {
    try {
      return JSON.parse(
        text.slice(start, end + 1)
      );
    } catch {}
  }

  return null;
}

/* =========================================================
   VAULT NORMALIZATION
   ========================================================= */

function arr(value) {
  return Array.isArray(value)
    ? value
    : [];
}

function clean(value) {
  return String(value ?? "")
    .trim()
    .replace(/\s+/g, " ");
}

function normalizeVault(vault = {}) {
  return {
    interests: arr(vault.interests)
      .map(clean)
      .filter(Boolean),

    hobbies: arr(vault.hobbies)
      .map(clean)
      .filter(Boolean),

    likings: arr(vault.likings)
      .map(clean)
      .filter(Boolean),

    strongSubjects: arr(
      vault.strongSubjects ??
      vault.subjects
    )
      .map(x => {
        if (typeof x === "string")
          return clean(x);

        return clean(
          x?.name
            ? `${x.name}${
                x.level
                  ? ` (${x.level})`
                  : ""
              }`
            : ""
        );
      })
      .filter(Boolean),

    preferredRoles: arr(
      vault.preferredRoles ??
      vault.preferredRolesInPriorityOrder ??
      vault.roles
    )
      .map(x => {
        if (typeof x === "string")
          return clean(x);

        return clean(
          x?.name ||
          x?.role ||
          x?.title ||
          ""
        );
      })
      .filter(Boolean),

    nonNegotiableCareer: clean(
      vault.nonNegotiableCareer ??
      vault.nonnegotiable ??
      vault.nonNegotiable ??
      ""
    ),

    skills: arr(
      vault.skills ??
      vault.verifiedSkills
    )
      .map(x => {
        if (typeof x === "string")
          return clean(x);

        return clean(
          x?.name
            ? `${x.name}${
                x.level
                  ? ` (${x.level})`
                  : ""
              }`
            : ""
        );
      })
      .filter(Boolean),

    chosenField: clean(
      vault.chosenField ??
      vault.field ??
      ""
    ),

    reasonForField: clean(
      vault.reasonForField ??
      vault.whyField ??
      ""
    ),

    reasonNotOtherFields: clean(
      vault.reasonNotOtherFields ??
      vault.whyNotOthers ??
      ""
    ),

    alternatives: arr(
      vault.alternatives ??
      vault.alternativesConsidered
    )
      .map(clean)
      .filter(Boolean)
  };
}

/* =========================================================
   TEST ZONE PROMPT
   ========================================================= */

function buildTestPrompt({
  vault,
  stage = "student",
  repair = false,
  previous = null,
  errors = []
}) {
  const V = normalizeVault(vault);

  return `
You are the AI question-generation engine for CareerMitra.

Your ONLY job is to generate a personalized career-counselling
test for ONE specific student.

STUDENT LIFE STAGE:
${stage}

PERSONAL VAULT:
${JSON.stringify(V, null, 2)}

==================================================
CORE REQUIREMENT
==================================================

Every question must be generated specifically using the
student's Personal Vault.

DO NOT use a generic pre-written question bank.

DO NOT generate the same questions for every student.

If Student A and Student B have different Vault information,
their questions MUST be meaningfully different.

The Vault is the source of personalization.

==================================================
QUESTION DISTRIBUTION
==================================================

Generate EXACTLY 25 questions:

1. Interests              = 5
2. Hobbies / Activities   = 4
3. Strong Subjects        = 4
4. Career / Role Choices  = 5
5. Skills / Strengths     = 4
6. Work Style / Personality = 3

TOTAL = 25

==================================================
PERSONALIZATION RULE
==================================================

For every question, include a "basedOn" field.

"basedOn" must identify the actual Personal Vault information
used to create that question.

Examples:

"Interests: robotics"

"Hobbies: chess"

"Strong Subject: Physics"

"Preferred Role: Data Scientist"

"Skill: Python"

"Chosen Field: Computer Science"

Never write vague values such as:

"General"

"Student profile"

"Career interests"

"Personal information"

unless the question genuinely cannot be grounded in a Vault
item.

At least 80% of the 25 questions MUST be directly grounded
in an actual Vault item.

Use different Vault items across the test.

Do not repeatedly use only the first interest.

==================================================
NEUTRALITY
==================================================

This is a CAREER COUNSELLING test.

Do NOT push the student toward:

- engineering
- medicine
- coding
- government jobs
- business
- any particular career

Do not make one option sound superior.

There are no "correct" personality answers.

The questions should discover the student's preferences,
not manipulate them.

==================================================
LANGUAGE
==================================================

Use very simple English.

Short questions.

Short options.

Suitable for a Class 8 student.

No unnecessary jargon.

==================================================
TRAIT SYSTEM
==================================================

For preference/personality questions use Holland codes:

R = Realistic
I = Investigative
A = Artistic
S = Social
E = Enterprising
C = Conventional

Each personality question should have four different
trait codes.

There is no correct personality answer.

Do not expose Holland names to the student.

==================================================
OUTPUT FORMAT
==================================================

Return ONLY valid JSON.

The output MUST be:

{
  "questions": [
    {
      "id": 1,
      "cat": "Interests",
      "basedOn": "Interests: robotics",
      "q": "If you could spend more time learning about robotics, what would interest you most?",
      "o": [
        {
          "text": "Building and testing machines",
          "trait": "R"
        },
        {
          "text": "Finding out how the machine works",
          "trait": "I"
        },
        {
          "text": "Designing how it looks",
          "trait": "A"
        },
        {
          "text": "Showing others how it works",
          "trait": "S"
        }
      ]
    }
  ]
}

For subject/knowledge questions where there is a genuine
correct answer, use:

{
  "text": "...",
  "correct": true
}

Do NOT mix "correct" and "trait" in the same option.

==================================================
HARD RULES
==================================================

Exactly 25 questions.

Exactly 4 options per question.

No duplicate questions.

No duplicate option inside a question.

Every question must have:

id
cat
basedOn
q
o

Every question must have meaningful personalization.

No empty questions.

No empty options.

No career-leading language.

No "which career is best" questions.

No questions that directly reveal the scoring system.

${
  repair
    ? `
==================================================
REPAIR MODE
==================================================

The previous AI output failed validation.

Previous output:
${JSON.stringify(previous, null, 2)}

Validation errors:
${JSON.stringify(errors, null, 2)}

Repair ONLY the problems.

Return a completely valid 25-question JSON object.

Do not fall back to generic questions.
Do not remove personalization.
`
    : ""
}
`;
}

/* =========================================================
   STRUCTURAL VALIDATION
   ========================================================= */

const CATEGORY_COUNTS = {
  Interests: 5,
  "Hobbies / Activities": 4,
  "Strong Subjects": 4,
  "Career / Role Choices": 5,
  "Skills / Strengths": 4,
  "Work Style / Personality": 3
};

function normalizeCategory(cat) {
  const s = clean(cat).toLowerCase();

  if (s.includes("interest"))
    return "Interests";

  if (
    s.includes("hobby") ||
    s.includes("activity")
  )
    return "Hobbies / Activities";

  if (
    s.includes("subject") ||
    s.includes("academic")
  )
    return "Strong Subjects";

  if (
    s.includes("career") ||
    s.includes("role")
  )
    return "Career / Role Choices";

  if (
    s.includes("skill") ||
    s.includes("strength")
  )
    return "Skills / Strengths";

  if (
    s.includes("work style") ||
    s.includes("personality")
  )
    return "Work Style / Personality";

  return clean(cat);
}

function validateTest(data, vault) {
  const errors = [];

  if (
    !data ||
    !Array.isArray(data.questions)
  ) {
    return {
      valid: false,
      errors: ["Missing questions array."]
    };
  }

  const questions = data.questions;

  if (questions.length !== 25) {
    errors.push(
      `Expected 25 questions, got ${questions.length}.`
    );
  }

  const counts = {};

  const normalizedVault =
    normalizeVault(vault);

  const vaultStrings = [
    ...normalizedVault.interests,
    ...normalizedVault.hobbies,
    ...normalizedVault.likings,
    ...normalizedVault.strongSubjects,
    ...normalizedVault.preferredRoles,
    ...normalizedVault.skills,
    normalizedVault.nonNegotiableCareer,
    normalizedVault.chosenField,
    normalizedVault.reasonForField,
    normalizedVault.reasonNotOtherFields,
    ...normalizedVault.alternatives
  ]
    .map(x => clean(x).toLowerCase())
    .filter(Boolean);

  const seenQuestions = new Set();

  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];

    if (!q || typeof q !== "object") {
      errors.push(
        `Question ${i + 1} is invalid.`
      );
      continue;
    }

    const category =
      normalizeCategory(q.cat);

    counts[category] =
      (counts[category] || 0) + 1;

    if (!clean(q.q)) {
      errors.push(
        `Question ${i + 1} has no text.`
      );
    }

    if (!clean(q.basedOn)) {
      errors.push(
        `Question ${i + 1} has no basedOn.`
      );
    }

    if (
      !Array.isArray(q.o) ||
      q.o.length !== 4
    ) {
      errors.push(
        `Question ${i + 1} must have exactly 4 options.`
      );
      continue;
    }

    const questionKey =
      clean(q.q).toLowerCase();

    if (seenQuestions.has(questionKey)) {
      errors.push(
        `Duplicate question: ${i + 1}.`
      );
    }

    seenQuestions.add(questionKey);

    const optionTexts = q.o
      .map(o =>
        clean(o?.text).toLowerCase()
      )
      .filter(Boolean);

    if (new Set(optionTexts).size !== 4) {
      errors.push(
        `Question ${i + 1} has duplicate options.`
      );
    }

    const personality =
      category ===
      "Work Style / Personality" ||
      category === "Interests" ||
      category === "Hobbies / Activities" ||
      category === "Career / Role Choices" ||
      category === "Skills / Strengths";

    if (personality) {
      const traits = q.o.map(
        o => clean(o?.trait).toUpperCase()
      );

      const validTraits =
        traits.every(t =>
          ["R", "I", "A", "S", "E", "C"]
            .includes(t)
        );

      if (validTraits) {
        if (
          new Set(traits).size !== 4
        ) {
          errors.push(
            `Question ${i + 1} must use 4 different Holland traits.`
          );
        }
      }
    }

    /*
     * Grounding check.
     *
     * We don't require exact wording because AI may paraphrase.
     * We require meaningful overlap with an actual Vault item.
     */
    if (
      category !== "Work Style / Personality"
    ) {
      const grounding =
        clean(q.basedOn).toLowerCase();

      const grounded =
        vaultStrings.some(item => {
          if (
            grounding.includes(item) ||
            item.includes(grounding)
          ) {
            return true;
          }

          const words = item
            .split(/[^a-z0-9]+/)
            .filter(w => w.length >= 4);

          if (!words.length)
            return false;

          const hits = words.filter(w =>
            grounding.includes(w)
          ).length;

          return hits >=
            Math.min(2, words.length);
        });

      if (!grounded) {
        errors.push(
          `Question ${i + 1} is not grounded in the student's Vault.`
        );
      }
    }
  }

  for (const [category, expected] of
    Object.entries(CATEGORY_COUNTS)) {
    if (
      (counts[category] || 0) !== expected
    ) {
      errors.push(
        `${category}: expected ${expected}, got ${
          counts[category] || 0
        }.`
      );
    }
  }

  /*
   * We intentionally require real personalization.
   */
  const groundedCount =
    questions.filter(q => {
      const b =
        clean(q?.basedOn).toLowerCase();

      return vaultStrings.some(item =>
        b.includes(item) ||
        item.includes(b)
      );
    }).length;

  if (groundedCount < 20) {
    errors.push(
      `Only ${groundedCount}/25 questions are clearly Vault-grounded. At least 20 are required.`
    );
  }

  return {
    valid: errors.length === 0,
    errors,
    groundedCount,
    counts
  };
}

/* =========================================================
   OPENROUTER
   ========================================================= */

async function requestAI(
  prompt,
  {
    maxAttempts = 3
  } = {}
) {
  const apiKey =
    process.env.OPENROUTER_API_KEY;

  if (!apiKey) {
    throw new Error(
      "OPENROUTER_API_KEY is missing."
    );
  }

  let lastError = null;

  for (
    let attempt = 0;
    attempt < maxAttempts;
    attempt++
  ) {
    const model =
      MODELS[
        attempt % MODELS.length
      ];

    try {
      const controller =
        new AbortController();

      const timeout =
        setTimeout(
          () => controller.abort(),
          30000
        );

      const response =
        await fetch(
          OPENROUTER_URL,
          {
            method: "POST",

            headers: {
              Authorization:
                `Bearer ${apiKey}`,

              "Content-Type":
                "application/json",

              "HTTP-Referer":
                "https://careermitra-zeta.vercel.app/",

              "X-Title":
                "CareerMitra"
            },

            body: JSON.stringify({
              model,

              messages: [
                {
                  role: "system",
                  content:
                    `
You are CareerMitra's AI engine.

Return ONLY valid JSON when JSON is requested.

Follow the user's supplied Personal Vault exactly.

Never replace missing student information
with generic assumptions.

Never fabricate Personal Vault data.
`
                },
                {
                  role: "user",
                  content: prompt
                }
              ],

              temperature: 0.85,

              max_tokens: 12000,

              provider: {
                allow_fallbacks: true
              }
            }),

            signal:
              controller.signal
          }
        );

      clearTimeout(timeout);

      const text =
        await response.text();

      if (!response.ok) {
        const err =
          new Error(
            `OpenRouter ${response.status}: ${text.slice(
              0,
              500
            )}`
          );

        err.status =
          response.status;

        throw err;
      }

      const json =
        JSON.parse(text);

      const output =
        extractText(json);

      if (!output) {
        throw new Error(
          "AI returned an empty response."
        );
      }

      return {
        text: output,
        model,
        attempt: attempt + 1
      };

    } catch (err) {
      lastError = err;

      const status =
        Number(err?.status);

      const retryable =
        !status ||
        RETRYABLE.has(status);

      if (
        attempt ===
          maxAttempts - 1 ||
        !retryable
      ) {
        break;
      }

      await sleep(
        400 * (attempt + 1)
      );
    }
  }

  throw lastError ||
    new Error(
      "AI request failed."
    );
}

/* =========================================================
   TEST GENERATION
   ========================================================= */

async function generateTest(
  vault,
  stage
) {
  const prompt =
    buildTestPrompt({
      vault,
      stage
    });

  let first;

  try {
    first =
      await requestAI(prompt, {
        maxAttempts: 3
      });
  } catch (err) {
    return {
      ok: false,
      reason: "AI_REQUEST_FAILED",
      error: err?.message ||
        "AI request failed."
    };
  }

  const parsed =
    parseJSON(first.text);

  const validation =
    validateTest(
      parsed,
      vault
    );

  if (validation.valid) {
    return {
      ok: true,
      data: parsed,
      aiGenerated: true,
      repaired: false,
      model: first.model,
      attempts: first.attempt,
      validation
    };
  }

  /*
   * AI output was bad.
   *
   * We do NOT use local questions.
   *
   * We ask AI to repair its own output.
   */
  try {
    const repairPrompt =
      buildTestPrompt({
        vault,
        stage,
        repair: true,
        previous: parsed,
        errors: validation.errors
      });

    const repaired =
      await requestAI(
        repairPrompt,
        {
          maxAttempts: 2
        }
      );

    const repairedJSON =
      parseJSON(
        repaired.text
      );

    const repairedValidation =
      validateTest(
        repairedJSON,
        vault
      );

    if (
      repairedValidation.valid
    ) {
      return {
        ok: true,
        data: repairedJSON,
        aiGenerated: true,
        repaired: true,
        model: repaired.model,
        attempts:
          first.attempt +
          repaired.attempt,
        validation:
          repairedValidation
      };
    }

    return {
      ok: false,
      reason:
        "AI_OUTPUT_FAILED_VALIDATION",
      error:
        "AI generated questions but the output did not pass CareerMitra validation.",
      validation:
        repairedValidation
    };

  } catch (err) {
    return {
      ok: false,
      reason:
        "AI_REPAIR_FAILED",
      error:
        err?.message ||
        "AI repair failed."
    };
  }
}

/* =========================================================
   OTHER AI REQUESTS
   ========================================================= */

function genericPrompt(prompt) {
  return `
You are CareerMitra, an AI career counselling assistant.

Follow the supplied user data exactly.

Do not invent facts.

Do not make unsupported career recommendations.

If JSON is requested, return ONLY valid JSON.

USER REQUEST:
${prompt}
`;
}

/* =========================================================
   API HANDLER
   ========================================================= */

export default async function handler(
  req,
  res
) {
  if (req.method !== "POST") {
    return res.status(405).json({
      ok: false,
      error:
        "Method not allowed."
    });
  }

  try {
    const body =
      req.body || {};

    const prompt =
      typeof body.prompt === "string"
        ? body.prompt
        : "";

    if (!prompt.trim()) {
      return res.status(400).json({
        ok: false,
        error:
          "Prompt is required."
      });
    }

    /*
     * Frontend sends this flag for Test Zone.
     */
    const isTestZone =
      body.purpose === "test" ||
      body.testZone === true ||
      /PERSONAL VAULT[\s\S]{0,10000}25/i.test(
        prompt
      );

    if (isTestZone) {
      const vault =
        body.vault ||
        {};

      const stage =
        body.stage ||
        "student";

      const result =
        await generateTest(
          vault,
          stage
        );

      if (!result.ok) {
        return res.status(503).json({
          ok: false,
          aiGenerated: false,
          fallbackAllowed: false,
          testZone: true,
          reason:
            result.reason,
          error:
            result.error,
          validation:
            result.validation ||
            null
        });
      }

      return res.status(200).json({
        ok: true,
        aiGenerated: true,
        fallbackAllowed: false,
        testZone: true,
        repaired:
          result.repaired,
        model:
          result.model,
        attempts:
          result.attempts,
        validation:
          result.validation,
        data:
          result.data
      });
    }

    /*
     * Normal CareerMitra AI request.
     */
    const result =
      await requestAI(
        genericPrompt(prompt),
        {
          maxAttempts: 3
        }
      );

    const parsed =
      parseJSON(result.text);

    return res.status(200).json({
      ok: true,
      aiGenerated: true,
      model:
        result.model,
      attempts:
        result.attempt,
      data:
        parsed || result.text
    });

  } catch (err) {
    console.error(
      "CareerMitra AI error:",
      err
    );

    return res.status(500).json({
      ok: false,
      aiGenerated: false,
      fallbackAllowed: false,
      error:
        err?.message ||
        "AI service failed."
    });
  }
}
