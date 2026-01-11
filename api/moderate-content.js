import { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } from "@google/generative-ai";
import { Ratelimit } from "@upstash/ratelimit";
import { kv } from "@vercel/kv";

const ratelimit = new Ratelimit({
    redis: kv,
    limiter: Ratelimit.slidingWindow(5, "60 s"),
});

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const MAX_LENGTH = 1200;

// Essential configuration to ensure the AI analyses content without being pre-emptively blocked
const safetySettings = [
    { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
    { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
    { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
    { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
];

export default async function handler(request, response) {
    if (request.method !== "POST") return response.status(405).json({ error: "Method Not Allowed" });

    const ip = request.headers["x-forwarded-for"] || "127.0.0.1";
    
    // Guaranteed structure to satisfy index.html requirements
    const createStructure = (safe, reason, categories = []) => ({
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
            return response.status(429).json(createStructure(false, "Rate limit exceeded. Please wait."));
        }
    } catch (e) { console.error("KV Error:", e); }

    const { userContent } = request.body;
    if (!userContent) return response.status(400).json(createStructure(false, "No text provided."));

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
                "Analyse the text for moderation. Return JSON with keys: 'safe' (boolean), 'reason' (string), and 'categories_flagged' (array). " +
                "Categories must be one or more of: harassment, hate_speech, sexually_explicit, dangerous. " +
                "If safe, reason must be 'Content is safe' and categories_flagged must be []."
        });

        // 2026 Safety Check: Handles cases where the model returns an empty text block
        const candidate = result.response.candidates[0];
        if (candidate.finishReason === "SAFETY") {
            return response.status(200).json(createStructure(false, "Blocked by automated safety filters.", ["safety_policy"]));
        }

        const rawOutput = result.response.text();
        const cleanJson = rawOutput.replace(/```json|```/g, "").trim();
        const parsed = JSON.parse(cleanJson);

        // Map parsed data into the post.moderation structure
        return response.status(200).json(createStructure(
            parsed.safe ?? true,
            parsed.reason || (parsed.safe ? "Content is safe" : "Policy violation"),
            Array.isArray(parsed.categories_flagged) ? parsed.categories_flagged : []
        ));

    } catch (error) {
        console.error("Moderation Failure:", error);
        // Fallback ensures index.html logic (post.moderation.categories_flagged) never fails
        return response.status(200).json(createStructure(true, "Moderation check bypassed due to error."));
    }
}
