import { GoogleGenerativeAI } from "@google/generative-ai";
import { Ratelimit } from "@upstash/ratelimit";
import { kv } from "@vercel/kv";

// Rate limiting setup
const ratelimit = new Ratelimit({
    redis: kv,
    limiter: Ratelimit.slidingWindow(5, "60 s"),
});

// Google GenAI client
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const MAX_LENGTH = 1200;

export default async function handler(request, response) {
    if (request.method !== "POST") {
        return response.status(405).json({ error: "Method Not Allowed" });
    }

    // Rate limit check
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
        // Updated model with JSON enforcement
        const model = genAI.getGenerativeModel({ 
            model: "gemini-2.5-flash-lite",
            generationConfig: {
                responseMimeType: "application/json",
            }
        });

        const result = await model.generateContent({
            contents: [
                {
                    role: "user",
                    parts: [{ text: userContent }],
                },
            ],
            systemInstruction:
                "Evaluate safety and respond in JSON format only. Provide a 'safe' boolean and 'reason' string."
        });

        const rawOutput = result.response.text();
        
        // Final safety layer: strip any potential Markdown code blocks
        const cleanJson = rawOutput.replace(/```json|```/g, "").trim();

        return response.status(200).json(JSON.parse(cleanJson));

    } catch (error) {
        console.error("Moderation Failure:", error);
        return response.status(500).json({
            error: "Moderation service temporarily unavailable.",
            details: error.message,
        });
    }
}
