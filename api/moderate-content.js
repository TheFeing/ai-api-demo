import { GoogleGenAI } from '@google/genai';
import { Ratelimit } from '@vercel/ratelimit';
import { kv } from '@vercel/kv';

// Initialise Rate Limiting via Marketplace KV (Upstash)
// Allow 5 requests per 60 seconds per IP address
const ratelimit = new Ratelimit({
  redis: kv,
  limiter: Ratelimit.slidingWindow(5, '60 s'),
});

// The SDK automatically picks up GEMINI_API_KEY from environment variables
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const MAX_LENGTH = 1200; 

export default async function handler(request, response) {
    if (request.method !== 'POST') {
        return response.status(405).json({ error: 'Method Not Allowed' });
    }

    // Rate Limit Check
    const ip = request.headers['x-forwarded-for'] || '127.0.0.1';
    const { success, reset } = await ratelimit.limit(`ratelimit_${ip}`);

    if (!success) {
        return response.status(429).json({
            error: 'Rate limit exceeded',
            message: 'To keep this demo free, please wait a moment.',
            resetAt: new Date(reset).toLocaleTimeString('en-GB')
        });
    }

    const { userContent } = request.body;

    // Input Validation
    if (!userContent || typeof userContent !== 'string' || userContent.length > MAX_LENGTH) {
        return response.status(400).json({ error: 'Invalid or overly long content.' });
    }

    try {
        const result = await ai.models.generateContent({
            model: 'gemini-1.5-flash', 
            contents: [{ role: 'user', parts: [{ text: userContent }] }],
            config: {
                systemInstruction: { 
                    parts: [{ text: "Evaluate safety and respond in JSON format. Provide a 'safe' boolean and 'reason' string." }] 
                },
                responseMimeType: "application/json"
            }
        });

        // Extract the text from the result
        const output = result.candidates?.[0]?.content?.parts?.[0]?.text;
        
        if (!output) {
            throw new Error('No content returned from AI');
        }

        return response.status(200).json(JSON.parse(output));

    } catch (error) {
        // Sanitised Error Reporting
        console.error('Moderation Failure:', error);
        return response.status(500).json({ error: 'Moderation service temporarily unavailable.' });
    }
}
