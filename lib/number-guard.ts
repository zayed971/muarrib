/**
 * Number-safety net for medical/technical pages.
 *
 * The dangerous failure for a drug leaflet isn't a clumsy sentence — it's a
 * dropped or altered dose. Given the page's source text (from the PDF text
 * layer; the English source extracts reliably) and the translated output, this
 * finds numbers present in the source but MISSING from the translation, so the
 * UI can flag that page for the user to check against the original.
 *
 * This is a FLAGGING aid, not a guarantee. It complements the prompt rule to
 * transcribe numbers verbatim; it does not replace human verification. It errs
 * toward flagging (some false positives are acceptable; a missed dose is not).
 * Pure and dependency-free — safe to run on the client.
 */

const ARABIC_INDIC = '٠١٢٣٤٥٦٧٨٩';
const EXTENDED_ARABIC_INDIC = '۰۱۲۳۴۵۶۷۸۹';

/** Convert Arabic-Indic / Persian digits to Western 0-9 for comparison. */
export function normalizeDigits(s: string): string {
  let out = '';
  for (const ch of String(s ?? '')) {
    const ai = ARABIC_INDIC.indexOf(ch);
    if (ai !== -1) {
      out += String(ai);
      continue;
    }
    const ei = EXTENDED_ARABIC_INDIC.indexOf(ch);
    if (ei !== -1) {
      out += String(ei);
      continue;
    }
    out += ch;
  }
  return out;
}

/** Extract distinct numeric tokens (integers, decimals) in canonical form. */
export function extractNumbers(text: string): string[] {
  const norm = normalizeDigits(text);
  const matches = norm.match(/\d+(?:[.,]\d+)*/g) ?? [];
  const canon = matches.map((m) =>
    m
      .replace(/,(?=\d{3}\b)/g, '') // strip thousands separators: 1,000 -> 1000
      .replace(',', '.'), // treat remaining comma as decimal point
  );
  return Array.from(new Set(canon));
}

export interface NumberCheck {
  ok: boolean;
  /** Numbers found in the source but not in the translation. */
  missing: string[];
}

/** Numbers present in the source text but missing from the translated text. */
export function findMissingNumbers(sourceText: string, translatedText: string): NumberCheck {
  const source = extractNumbers(sourceText);
  const target = new Set(extractNumbers(translatedText));
  const missing = source.filter((n) => !target.has(n));
  return { ok: missing.length === 0, missing };
}
