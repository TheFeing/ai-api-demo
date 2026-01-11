import { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } from "@google/generative-ai";
import { Ratelimit } from "@upstash/ratelimit";
import { kv } from "@vercel/kv";

const ratelimit = new Ratelimit({
    redis: kv,
    limiter: Ratelimit.slidingWindow(5, "60 s"),
});

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const MAX_LENGTH = 1200;

// --- SAFETY CONFIGURATION ---
// Setting these to BLOCK_ONLY_HIGH prevents 'false positives' on safe text.
const safetySettings = [
    { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
    { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
    { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
    { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
];

export default async function handler(request, response) {
    if (request.method !== "POST") {
        return response.status(405).json({ error: "Method Not Allowed" });
    }

    const ip = request.headers["x-forwarded-for"] || "127.0.0.1";
    try {
        const { success } = await ratelimit.limit(`ratelimit_${ip}`);
        if (!success) return response.status(429).json({ error: "Rate limit exceeded" });
    } catch (e) { console.error("KV Error:", e); }

    const { userContent } = request.body;

    try {
        const model = genAI.getGenerativeModel({ 
            model: "gemini-2.5-flash-lite",
            generationConfig: { responseMimeType: "application/json" },
            safetySettings, // Applied the block here
        });

        const result = await model.generateContent({
            contents: [{ role: "user", parts: [{ text: userContent }] }],
            systemInstruction: 
                "Return JSON with: 'safe' (boolean), 'reason' (string), and 'categories_flagged' (array). " +
                "If content is safe, set 'reason' to 'Content is safe' and 'categories_flagged' to []."
        });

        const rawOutput = result.response.text();
        const cleanJson = rawOutput.replace(/```json|```/g, "").trim();
        const parsed = JSON.parse(cleanJson);

        // Map to exact frontend keys to avoid 'undefined'
        const finalResponse = {
            safe: parsed.safe ?? true,
            reason: parsed.reason || (parsed.safe ? "Content is safe" : "Policy violation"),
            categories_flagged: parsed.categories_flagged || []
        };

        return response.status(200).json(finalResponse);

    } catch (error) {
        console.error("Moderation Failure:", error);
        return response.status(200).json({
            safe: true,
            reason: "Safety check bypassed due to a system error.",
            categories_flagged: []
        });
    }
}
