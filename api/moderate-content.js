import { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } from "@google/generative-ai";
import { Ratelimit } from "@upstash/ratelimit";
import { kv } from "@vercel/kv";

const ratelimit = new Ratelimit({
    redis: kv,
    limiter: Ratelimit.slidingWindow(5, "60 s"),
});

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const MAX_LENGTH = 1200;

// Safety settings ensure the model performs its own analysis without being blocked by provider-level filters
const safetySettings = [
    { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
    { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
    { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
    { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
];

export default async function handler(request, response) {
    if (request.method !== "POST") return response.status(405).json({ error: "Method Not Allowed" });

    const ip = request.headers["x-forwarded-for"] || "127.0.0.1";
    
    // Helper function ensures the JSON structure matches index.html (line 108)
    const formatResponse = (safe, reason, categories = []) => ({
        post: {
            moderation: {
                safe: safe,
                reason: reason,
                categories_flagged: categories
            }
        }
    });

    try {
        const { success } = await ratelimit.limit(`ratelimit_${ip}`);
        if (!success) {
            return response.status(429).json(formatResponse(false, "Rate limit exceeded. Please wait."));
        }
    } catch (e) { console.error("KV Error:", e); }

    const { userContent } = request.body;
    if (!userContent) return response.status(400).json(formatResponse(false, "No content provided."));

    try {
        const model = genAI.getGenerativeModel({ 
            model: "gemini-2.5-flash-lite",
            generationConfig: { 
                responseMimeType: "application/json",
                temperature: 0.1 
            },
            safetySettings,
        });

        const result = await model.generateContent({
            contents: [{ role: "user", parts: [{ text: userContent }] }],
            systemInstruction: 
                "Analyse text for safety. Return JSON with keys: 'safe' (boolean), 'reason' (string), and 'categories_flagged' (array of strings). " +
                "If content is safe, set 'reason' to 'Content is safe' and 'categories_flagged' to []. " +
                "If unsafe, categorise as harassment, hate_speech, sexually_explicit, or dangerous."
        });

        const candidate = result.response.candidates[0];
        if (candidate.finishReason === "SAFETY") {
            return response.status(200).json(formatResponse(false, "Blocked by provider safety filters.", ["safety_policy"]));
        }

        const rawOutput = result.response.text();
        const cleanJson = rawOutput.replace(/```json|```/g, "").trim();
        const parsed = JSON.parse(cleanJson);

        return response.status(200).json(formatResponse(
            parsed.safe ?? true,
            parsed.reason || "Content analysis complete.",
            Array.isArray(parsed.categories_flagged) ? parsed.categories_flagged : []
        ));

    } catch (error) {
        console.error("Moderation Failure:", error);
        // Fail-open fallback ensures property checks in index.html do not fail
        return response.status(200).json(formatResponse(true, "Moderation service error."));
    }
}
