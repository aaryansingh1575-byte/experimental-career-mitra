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

  const c = data?.choices?.[0];

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
    /common ground|
     both sides|
     family concerns|
     student test analysis|
     decision-support analyst/i
      .test(p)
  ) {
    return "common-ground analysis";
  }

  if (
    /parent|
     family|
     sincere|
     specific|
     relevant response|
     concern/i
      .test(p)
  ) {
    return "family question/answer analysis";
  }

  if (
    /complete test|
     question plan|
     holland|
     personal vault|
     multiple-choice questions/i
      .test(p)
  ) {
    return "student test generation";
  }

  if (
    /personality-and-interest test|
     holland-code tallies|
     career counsellor/i
      .test(p)
  ) {
    return "student test answer analysis";
  }

  return "career counselling";
}


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

Return ONLY valid JSON.

Never return markdown,
prose outside JSON,
or code fences.


GENERAL RULES:

- Use supplied student/family information exactly.
- Never invent personal facts.
- Never silently replace a student's chosen career.
- Never treat generic family support as career-specific evidence.
- Never treat absence of a concern as a positive career preference.
- Never invent salary numbers.
- Never invent sources.
- Never invent qualifications.
- Prefer India-specific evidence.
- Be specific and useful.
- Avoid filler.


COMMON-GROUND RULES:

When analysing Student + Family:

1. Explicit career preference is strong evidence.

Example:
"I want him to become a commercial pilot."

This is career-specific evidence.

2. Career-specific positive reasoning is evidence.

Example:
"Flying is his liking so pilot is a good option."

3. Generic support is NOT career evidence.

Example:
"I support whatever he wants."

4. Financial neutrality is NOT high-income preference.

Example:
"Salary is no problem."

This means:
DO NOT penalise a career because of salary.

It does NOT mean:
give high-paying careers bonus points.

5. Social neutrality is NOT social approval.

Example:
"I don't care what relatives think."

This means:
social reputation is NOT a constraint.

6. Location neutrality is NOT location preference.

Example:
"No problem, everyone has to go."

7. Explicit disagreement must be represented as a conflict.

8. Never force exactly three careers.

If only one or two genuine overlaps exist,
return one or two.

9. Never rank a career only because it is popular,
high-paying, stable or prestigious.

10. Every selected common-ground career must have:
- real student evidence
AND
- real family-specific evidence.

11. Generic support alone cannot satisfy the
family evidence requirement.

12. Preserve the family's actual wording where useful.

13. Expose conflicts instead of hiding them.


${webSearch ? `

LIVE RESEARCH QUALITY:

- Use the web evidence supplied in the user message.
- Cross-check important claims where possible.
- Prefer official Indian authorities.
- Prefer NMC, NBEMS, MCC, AIIMS,
  government sources, Indian universities,
  established Indian hospitals and reputable
  Indian job portals.
- Never treat one job listing as proof of national demand.
- Never invent salary data.
- Keep the exact requested career.
- Keep specialisations central.
- For medical careers distinguish:
  MBBS,
  registration,
  postgraduate specialty training,
  fellowship/subspecialization.
` : ""}


${repair ? `

THIS IS A RECOVERY PASS.

The previous AI response was incomplete
or malformed.

Rebuild the complete JSON.

Do not shorten the answer merely
to finish quickly.
` : ""}
`;


  const maxAttempts =
    repair ? 2 : 2;

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
          response.headers
            .get("retry-after");

        error.providerCode =
          data?.error
            ?.metadata
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
       * Do not hammer a 429.
       * Account-level quota will not disappear
       * after a few milliseconds.
       */

      if (status === 429)
        break;


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
