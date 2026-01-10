import { createGenAI } from '@google/genai';
import { Ratelimit } from '@upstash/ratelimit';
import { kv } from '@vercel/kv';

// Initialise Rate Limiting via Vercel KV
const ratelimit = new Ratelimit({
  redis: kv,
  limiter: Ratelimit.slidingWindow(5, '60 s'),
});

// Initialise the latest Google Gen AI Client
const client = createGenAI({ apiKey: process.env.GEMINI_API_KEY });
const MAX_LENGTH = 1200; 

export default async function handler(request, response) {
    if (request.method !== 'POST') {
        return response.status(405).json({ error: 'Method Not Allowed' });
    }

    // Rate Limit Check
    const ip = request.headers['x-forwarded-for'] || '127.0.0.1';
    try {
        const { success, reset } = await ratelimit.limit(`ratelimit_${ip}`);
        if (!success) {
            return response.status(429).json({
                error: 'Rate limit exceeded',
                message: 'To keep this demo free, please wait a moment.',
                resetAt: new Date(reset).toLocaleTimeString('en-GB')
            });
        }
    } catch (error) {
        console.error('KV Error:', error);
        // If KV fails, we log it but continue so the site doesn't break
    }

    const { userContent } = request.body;

    // Input Validation
    if (!userContent || typeof userContent !== 'string' || userContent.length > MAX_LENGTH) {
        return response.status(400).json({ error: 'Invalid or overly long content.' });
    }

    try {
        // Modern syntax for Gemini 1.5 Flash
        const result = await client.models.generateContent({
            model: 'gemini-1.5-flash',
            contents: [{ role: 'user', parts: [{ text: userContent }] }],
            config: {
                systemInstruction: "Evaluate safety and respond in JSON format. Provide a 'safe' boolean and 'reason' string.",
                responseMimeType: "application/json"
            }
        });

        // Extracting text from the latest SDK response object
        const output = result.candidates?.[0]?.content?.parts?.[0]?.text;
        
        if (!output) {
            throw new Error('No content returned from AI');
        }

        return response.status(200).json(JSON.parse(output));

    } catch (error) {
        console.error('Moderation Failure:', error);
        return response.status(500).json({ 
            error: 'Moderation service temporarily unavailable.',
            details: error.message 
        });
    }
}
