import { GoogleGenerativeAI } from "@google/genai";
import { Ratelimit } from "@upstash/ratelimit";
import { kv } from "@vercel/kv";

// Rate limiting
const ratelimit = new Ratelimit({
  redis: kv,
  limiter: Ratelimit.slidingWindow(5, "60 s"),
});

// Google Gen AI client (new SDK)
const genAI = new GoogleGenerativeAI({
  apiKey: process.env.GEMINI_API_KEY,
});

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
      model: "gemini-2.5-flash",
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

Analyze the user content and respond ONLY with a single JSON object in this exact shape:

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
      `.trim(),
    });

    const rawText = result.response.text();

    let parsed;
    try {
      parsed = JSON.parse(rawText);
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

    return response.status(200).json(normalized);
  } catch (error) {
    console.error("Moderation Failure:", error);
    return response.status(500).json({
      error: "Moderation service temporarily unavailable.",
      details: error.message,
    });
  }
}
