/**
 * Output safety. The model reads arbitrary PDFs, so its output is UNTRUSTED —
 * treat every string it returns as potentially hostile HTML. A crafted PDF could
 * try to make the model emit a script tag; if the client renders that with innerHTML,
 * it runs. Two defenses:
 *   1. escapeHtml at the single render point (below).
 *   2. On the client, also run the assembled HTML through DOMPurify as a net.
 */

/** Escape the 5 HTML-significant characters. Use this at render time only. */
export function escapeHtml(input: string): string {
  return String(input ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Build the control-character pattern from code points to avoid embedding raw
// control-character escapes in source. Ranges: C0 controls except tab/LF/CR,
// plus DEL (0x7F).
const hex = (n: number) => n.toString(16).padStart(2, '0');
const CONTROL_RANGES: Array<[number, number]> = [
  [0x00, 0x08],
  [0x0b, 0x0c],
  [0x0e, 0x1f],
  [0x7f, 0x7f],
];
const CONTROL_PATTERN =
  '[' +
  CONTROL_RANGES.map(([a, b]) => (a === b ? `\\x${hex(a)}` : `\\x${hex(a)}-\\x${hex(b)}`)).join('') +
  ']';
const CONTROL_CHARS_RE = new RegExp(CONTROL_PATTERN, 'g');

/**
 * Strip control characters and null bytes from model text (defense in depth).
 * Keeps tab/newline/carriage-return. Does NOT HTML-escape — escaping happens
 * exactly once, at render, via escapeHtml, to avoid double-escaping.
 */
export function sanitizeText(input: string): string {
  return String(input ?? '')
    .replace(CONTROL_CHARS_RE, '')
    .trim();
}
