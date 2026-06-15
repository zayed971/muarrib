import Anthropic from '@anthropic-ai/sdk';
import { MAX_TOKENS } from '@/lib/config';
import { buildPrompt } from '@/lib/prompt';
import type { PageInput, RawResult, TranslationProvider } from './types';

async function translate({ imageBase64, pageNum, apiKey, model }: PageInput): Promise<RawResult> {
  const client = new Anthropic({ apiKey });

  const message = await client.messages.create({
    model,
    max_tokens: MAX_TOKENS,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/jpeg', data: imageBase64 },
          },
          { type: 'text', text: buildPrompt(pageNum) },
        ],
      },
    ],
  });

  type TextBlock = Extract<(typeof message.content)[number], { type: 'text' }>;
  const text = message.content
    .filter((b): b is TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n');

  if (!text) throw new Error('Empty response from Anthropic');
  return { text, truncated: message.stop_reason === 'max_tokens' };
}

export const anthropicProvider: TranslationProvider = {
  name: 'anthropic',
  translate,
};
