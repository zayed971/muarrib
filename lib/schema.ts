/**
 * The data contract. Every page the model returns is validated against this
 * before it reaches the UI — if the model returns junk, we reject it here
 * instead of rendering garbage. Types are INFERRED from the schema, so the
 * contract and the TypeScript types can never drift apart.
 */
import { z } from 'zod';
import { PROVIDERS } from './config';
import { AppError } from './errors';

const lowconf = z.boolean().optional();

const Heading = z.object({ type: z.literal('heading'), ar: z.string(), en: z.string().optional(), lowconf });
const Subheading = z.object({ type: z.literal('subheading'), ar: z.string(), en: z.string().optional(), lowconf });
const Paragraph = z.object({ type: z.literal('paragraph'), ar: z.string(), lowconf });
const ListBlock = z.object({ type: z.literal('list'), items: z.array(z.string()), lowconf });
const Caption = z.object({ type: z.literal('caption'), ar: z.string(), lowconf });
const Figure = z.object({ type: z.literal('figure'), ar: z.string(), lowconf });
const Equation = z.object({ type: z.literal('equation'), content: z.string(), lowconf });
const Code = z.object({ type: z.literal('code'), content: z.string(), lowconf });

/** A table cell may arrive as a bare string or an {ar,en} object — accept both. */
const TableCell = z.union([z.string(), z.object({ ar: z.string(), en: z.string().optional() })]);
const TableBlock = z.object({ type: z.literal('table'), rows: z.array(z.array(TableCell)), lowconf });

export const BlockSchema = z.discriminatedUnion('type', [
  Heading,
  Subheading,
  Paragraph,
  ListBlock,
  Caption,
  Figure,
  Equation,
  Code,
  TableBlock,
]);
export const BlocksSchema = z.array(BlockSchema);

export type SchemaBlock = z.infer<typeof BlockSchema>;
export type TableCellT = z.infer<typeof TableCell>;

/** Validated request body for POST /api/translate-page. */
export const TranslateRequestSchema = z.object({
  imageBase64: z.string().min(1),
  pageNum: z.number().int().positive(),
  provider: z.enum(PROVIDERS),
});
export type TranslateRequest = z.infer<typeof TranslateRequestSchema>;

/**
 * Extract and validate the JSON block array from raw model text.
 * Handles ```code fences``` and leading/trailing prose. Throws AppError on failure
 * so the route can return a clean PARSE_FAILED to the UI's per-page Retry.
 */
export function parseModelText(text: string): SchemaBlock[] {
  const cleaned = (text ?? '')
    .trim()
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/i, '')
    .trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf('[');
    const end = cleaned.lastIndexOf(']');
    if (start !== -1 && end > start) {
      try {
        parsed = JSON.parse(cleaned.slice(start, end + 1));
      } catch {
        throw new AppError('PARSE_FAILED', 'JSON.parse failed after slice');
      }
    } else {
      throw new AppError('PARSE_FAILED', 'no JSON array found in model output');
    }
  }

  const result = BlocksSchema.safeParse(parsed);
  if (!result.success) {
    throw new AppError('PARSE_FAILED', result.error.message);
  }
  return result.data;
}
