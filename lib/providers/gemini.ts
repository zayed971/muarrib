import { GoogleGenerativeAI, FinishReason } from '@google/generative-ai';
import { GEMINI_MODEL, MAX_TOKENS } from '@/lib/config';
import { buildPrompt } from '@/lib/prompt';

export async function callGemini(
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
