/**
 * Input hardening for the page image. Rejects oversized or non-base64 payloads
 * BEFORE they reach the model, protecting your AI budget and staying under the
 * Vercel request-body limit. Returns the cleaned base64 string (whitespace removed).
 */
import { LIMITS } from './config';
import { AppError } from './errors';

export function validateImageBase64(b64: unknown): string {
  if (typeof b64 !== 'string' || b64.length === 0) {
    throw new AppError('INVALID_INPUT', 'missing image data');
  }
  // base64 decodes to roughly 3/4 of its string length
  const approxBytes = Math.floor(b64.length * 0.75);
  if (approxBytes > LIMITS.maxImageBytes) {
    throw new AppError('INVALID_INPUT', `image too large: ~${approxBytes} bytes`);
  }
  if (!/^[A-Za-z0-9+/=\s]+$/.test(b64)) {
    throw new AppError('INVALID_INPUT', 'not valid base64');
  }
  return b64.replace(/\s+/g, '');
}
