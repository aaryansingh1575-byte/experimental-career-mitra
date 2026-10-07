export const maxDuration = 10;

function cleanText(value, max = 12000) {
  return String(value ?? "")
    .replace(/\u0000/g, "")
    .trim()
    .slice(0, max);
}

function extractCareer(text = "") {
  const m = text.match(
    /(?:career|role|job|profession)\s*[:\-]\s*([^\n,.;]+)/i
  );
  return cleanText(m?.[1] || text.split("\n")[0] || "Career", 160);
}

function isBadResult(value) {
  if (!value) return true;

  const text = typeof value === "string"
    ? value
    : JSON.stringify(value);

  return /I can't|I cannot|unable to|error|not available/i.test(text);
}

async function searchWeb(query) {
  try {
    const q = encodeURIComponent(cleanText(query, 500));

    const response = await fetch(
      `https://www.bing.com/search?format=rss&q=${q}`,
      {
        headers: {
          "User-Agent": "Mozilla/5.0"
        }
      }
    );

    if (!response.ok) return [];

    const xml = await response.text();

    const items = [...xml.matchAll(
      /<item>([\s\S]*?)<\/item>/gi
    )];

    return items.slice(0, 8).map(item => {
      const block = item[1];

      const title =
        block.match(/<title>([\s\S]*?)<\/title>/i)?.[1]
          ?.replace(/<!\[CDATA\[|\]\]>/g, "")
          ?.trim() || "";

      const link =
        block.match(/<link>([\s\S]*?)<\/link>/i)?.[1]
          ?.trim() || "";

      const description =
        block.match(/<description>([\s\S]*?)<\/description>/i)?.[1]
          ?.replace(/<!\[CDATA\[|\]\]>/g, "")
          ?.replace(/<[^>]+>/g, "")
          ?.trim() || "";

      return {
        title: cleanText(title, 300),
        url: cleanText(link, 1000),
        description: cleanText(description, 700)
      };
    }).filter(x => x.title && x.url);

  } catch {
    return [];
  }
}

function sourcePriority(source) {
  const url = source?.url || "";

  if (/gov\.in|nic\.in/i.test(url)) return 5;
  if (/ncs\.gov\.in|education\.gov\.in/i.test(url)) return 5;
  if (/linkedin\.com|indeed\.com|glassdoor/i.test(url)) return 4;
  if (/coursera|udemy|edx/i.test(url)) return 3;

  return 1;
}

function extractModelText(data) {
  return (
    data?.choices?.[0]?.message?.content ||
    data?.choices?.[0]?.text ||
    ""
  );
}

function parseJSON(text) {
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {}

  const match = text.match(/\{[\s\S]*\}/);

  if (!match) return null;

  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

async function callAI(prompt) {
  const apiKey = process.env.OPENROUTER_API_KEY;

  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY is missing");
  }

  const response = await fetch(
    "https://openrouter.ai/api/v1/chat/completions",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
        "HTTP-Referer": "https://careermitra.vercel.app",
        "X-Title": "CareerMitra"
      },
      body: JSON.stringify({
        model: "nvidia/nemotron-3-ultra-550b-a55b:free",
        temperature: 0.2,
        messages: [
          {
            role: "system",
            content:
              "You are CareerMitra, an AI career counselling and family decision-support assistant. Give practical, structured and India-relevant career guidance. Never silently replace a student's non-negotiable career."
          },
          {
            role: "user",
            content: prompt
          }
        ]
      })
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `OpenRouter error ${response.status}: ${errorText.slice(0, 500)}`
    );
  }

  return response.json();
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      ok: false,
      error: "Method not allowed"
    });
  }

  try {
    const body = req.body || {};

    const prompt = cleanText(
      body.prompt ||
      body.message ||
      body.query ||
      "",
      14000
    );

    const webSearch = Boolean(
      body.webSearch ||
      body.searchWeb ||
      body.liveResearch
    );

    if (!prompt) {
      return res.status(400).json({
        ok: false,
        error: "Prompt is required"
      });
    }

    let sources = [];

    if (webSearch) {
      const career = extractCareer(prompt);

      sources = await searchWeb(
        `${career} career India salary demand education skills`
      );

      sources = sources
        .sort((a, b) => sourcePriority(b) - sourcePriority(a))
        .slice(0, 8);
    }

    const sourceText = sources.length
      ? sources.map((s, i) =>
          `${i + 1}. ${s.title}\n${s.url}\n${s.description}`
        ).join("\n\n")
      : "No live web sources were retrieved.";

    const finalPrompt = `
You are generating career guidance for CareerMitra.

User/student context:
${prompt}

${webSearch ? `
LIVE WEB RESEARCH SOURCES:
${sourceText}

Use these sources where relevant. Do not invent facts that are not supported by the available information.
` : ""}

Return useful, practical information for an Indian student.

If the request is about a specific career, cover where relevant:
- What the career involves
- Pros
- Cons / trade-offs
- Market
- Current demand
- Future growth
- Indicative India pay
- Academic education route
- Vocational / diploma route
- Certifications
- Job-ready skills
- Step-by-step pathway
- Alternatives
- Barriers
- Rewards

Keep the student's non-negotiable career separate and never silently replace it with another career.

Return JSON wherever possible.
`;

    const aiResponse = await callAI(finalPrompt);

    const modelText = extractModelText(aiResponse);

    if (!modelText || isBadResult(modelText)) {
      return res.status(502).json({
        ok: false,
        error: "AI returned an invalid response",
        sources
      });
    }

    const parsed = parseJSON(modelText);

    return res.status(200).json({
      ok: true,
      data: parsed || modelText,
      sources
    });

  } catch (error) {
    console.error("CareerMitra AI error:", error);

    return res.status(500).json({
      ok: false,
      error: error?.message || "Internal server error"
    });
  }
}
