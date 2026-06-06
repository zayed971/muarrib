import { GoogleGenerativeAI, FinishReason } from '@google/generative-ai';
import { GEMINI_MODEL, MAX_TOKENS } from '@/lib/config';
import { buildPrompt } from '@/lib/prompt';

function retryDelayMs(err: Error): number {
  // Parse the suggested retry delay from the Gemini error body ("retry in 20.25s")
  const m = err.message.match(/retry in (\d+(?:\.\d+)?)s/i);
  return m ? Math.ceil(parseFloat(m[1]) * 1000) : 30_000;
}

async function generate(
  imageBase64: string,
  pageNum: number,
  apiKey: string,
): Promise<{ text: string; truncated: boolean }> {
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: GEMINI_MODEL });

  const result = await model.generateContent({
    contents: [
      {
        role: 'user',
        parts: [
          { inlineData: { mimeType: 'image/jpeg', data: imageBase64 } },
          { text: buildPrompt(pageNum) },
        ],
      },
    ],
    generationConfig: { maxOutputTokens: MAX_TOKENS },
  });

  let text: string;
  try {
    text = result.response.text();
  } catch {
    const reason = result.response.candidates?.[0]?.finishReason ?? 'no candidates';
    throw new Error(`Gemini generation blocked or empty: ${reason}`);
  }

  if (!text) throw new Error('Empty response from Gemini');
  const finishReason = result.response.candidates?.[0]?.finishReason;
  return { text, truncated: finishReason === FinishReason.MAX_TOKENS };
}

export async function callGemini(
  imageBase64: string,
  pageNum: number,
  apiKey: string,
): Promise<{ text: string; truncated: boolean }> {
  try {
    return await generate(imageBase64, pageNum, apiKey);
  } catch (err) {
    if (err instanceof Error && err.message.includes('[429')) {
      // Free tier: 5 req/min. Wait for the server-suggested delay (capped to stay
      // inside Vercel's 60-second function window) then retry once.
      const delay = Math.min(retryDelayMs(err), 30_000);
      await new Promise(r => setTimeout(r, delay));
      return generate(imageBase64, pageNum, apiKey);
    }
    throw err;
  }
}
