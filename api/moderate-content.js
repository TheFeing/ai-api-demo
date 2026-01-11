import { GoogleGenerativeAI } from "@google/generative-ai";
import { Ratelimit } from "@upstash/ratelimit";
import { kv } from "@vercel/kv";

// Profanity censorship
function censorProfanity(text) {
  const badWords = [
    "fuck",
    "shit",
    "bitch",
    "asshole",
    "bastard",
    "dick",
    "piss",
    "cunt"
  ];

  let output = text;

  for (const word of badWords) {
    // Build a regex that matches:
    // - the raw word
    // - partially censored versions (f*ck, f**k, s***, etc.)
    // - the word inside larger strings
    const pattern = word
      .split("")
      .map(ch => `[${ch}${ch.toUpperCase()}*]`)
      .join("");

    const regex = new RegExp(pattern, "g");

    output = output.replace(regex, (match) => {
      // Normalize: remove existing asterisks
      const cleaned = match.replace(/\*/g, "");

      // Style A: keep first + last letter, censor middle
      if (cleaned.length <= 2) {
        return cleaned[0] + "*";
      }

      return (
        cleaned[0] +
        "*".repeat(cleaned.length - 2) +
        cleaned[cleaned.length - 1]
      );
    });
  }

  return output;
}


// Rate limiting
const ratelimit = new Ratelimit({
  redis: kv,
  limiter: Ratelimit.slidingWindow(5, "60 s"),
});

// Google GenAI client (older but stable SDK)
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const MAX_LENGTH = 1200;

export default async function handler(request, response) {
  if (request.method !== "POST") {
    return response.status(405).json({ error: "Method Not Allowed" });
  }

  // Rate limit
  const ip = request.headers["x-forwarded-for"] || "127.0.0.1";
  try {
    const { success, reset } = await ratelimit.limit(`ratelimit_${ip}`);
    if (!success) {
      return response.status(429).json({
        error: "Rate limit exceeded",
        message: "To keep this demo free, please wait a moment.",
        resetAt: new Date(reset).toLocaleTimeString("en-GB"),
      });
    }
  } catch (error) {
    console.error("KV Error:", error);
  }

  const { userContent } = request.body;

  if (!userContent || typeof userContent !== "string" || userContent.length > MAX_LENGTH) {
    return response.status(400).json({ error: "Invalid or overly long content." });
  }

  try {
    const model = genAI.getGenerativeModel({
      model: "gemini-2.5-flash-lite",
    });

    const result = await model.generateContent({
      contents: [
        {
          role: "user",
          parts: [{ text: userContent }],
        },
      ],
      systemInstruction: `
You are a strict content safety moderator.

Respond ONLY with a single JSON object in this exact shape:

{
  "is_safe": boolean,
  "moderator_comment": string,
  "categories_flagged": string[]
}

Rules:
- "is_safe": true if the content is allowed for a general social media feed; false if it should be blocked.
- "moderator_comment": a short, clear explanation suitable for end users (1–2 sentences).
- "categories_flagged": an array of high-level categories (e.g. "Violence", "Hate", "Harassment", "Sexual Content", "Self-harm", "Drugs", "Spam"). Use [] if is_safe is true.
- Do NOT include any other fields.
- Do NOT wrap the JSON in backticks or markdown.
- Never wrap your response in backticks or markdown fences. Output ONLY raw JSON.

Additional profanity rules:
- ANY profanity (e.g., "fuck", "shit", "bitch", "dick", "cunt", "asshole") MUST be added to "categories_flagged" as "Profanity".
- Profanity alone should NOT make the content unsafe. Set "is_safe": true for profanity-only content.
- ALWAYS include "Profanity" in "categories_flagged" when profanity is present, even inside larger words (e.g., "ifuckingloveit", "janecunt", "peterdickhead").

      `.trim(),
    });

    const rawText = result.response.text();
    
    // Remove Markdown fences if the model added them
    const cleaned = rawText
      .replace(/```json/gi, "")
      .replace(/```/g, "")
      .trim();
    
    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (parseError) {
      console.error("Failed to parse model JSON:", rawText, parseError);
      return response.status(500).json({
        error: "Failed to parse moderation response.",
        details: "Model returned invalid JSON.",
      });
    }

    // Normalize to guarantee the shape the frontend expects
    const normalized = {
      is_safe: Boolean(parsed.is_safe),
      moderator_comment:
        typeof parsed.moderator_comment === "string" && parsed.moderator_comment.trim().length > 0
          ? parsed.moderator_comment.trim()
          : "No moderator comment provided.",
      categories_flagged: Array.isArray(parsed.categories_flagged)
        ? parsed.categories_flagged.map(String)
        : [],
    };

    // Apply profanity censorship if needed
    let censoredContent = userContent;

  
    // Always censor profanity in safe content
    if (normalized.is_safe) {
      censoredContent = censorProfanity(userContent);
    }
    
    return response.status(200).json({
      ...normalized,
      censored_content: censoredContent
    });
    
  } catch (error) {
    console.error("Moderation Failure:", error);
    return response.status(500).json({
      error: "Moderation service temporarily unavailable.",
      details: error.message,
    });
  }
}
