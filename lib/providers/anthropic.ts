import Anthropic from '@anthropic-ai/sdk';
import { ANTHROPIC_MODEL, MAX_TOKENS } from '@/lib/config';
import { buildPrompt } from '@/lib/prompt';

export async function callAnthropic(
  imageBase64: string,
  pageNum: number,
  apiKey: string,
): Promise<{ text: string; truncated: boolean }> {
  const client = new Anthropic({ apiKey });

  const message = await client.messages.create({
    model: ANTHROPIC_MODEL,
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
