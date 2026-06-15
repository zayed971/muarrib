import { GoogleGenerativeAI, FinishReason } from '@google/generative-ai';
import { MAX_TOKENS } from '@/lib/config';
import { buildPrompt } from '@/lib/prompt';
import type { PageInput, RawResult, TranslationProvider } from './types';

async function translate({ imageBase64, pageNum, apiKey, model }: PageInput): Promise<RawResult> {
  const genAI = new GoogleGenerativeAI(apiKey);
  const genModel = genAI.getGenerativeModel({ model });

  const result = await genModel.generateContent({
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

export const geminiProvider: TranslationProvider = {
  name: 'gemini',
  translate,
};
