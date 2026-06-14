// Verify current model strings before shipping:
// Anthropic: https://docs.claude.com/en/docs/about-claude/models
// Gemini:    https://ai.google.dev/gemini-api/docs/models
export const ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001';
export const GEMINI_MODEL = 'gemini-2.5-flash';
export const MAX_TOKENS = 4096;

export const PROVIDERS = ['anthropic', 'gemini'] as const;

/** Model IDs. Verify against each provider's current model list before launch. */
export const MODELS = {
  anthropic: {
    default: ANTHROPIC_MODEL, // cheap + reliable, no RECITATION blocks
    highQuality: 'claude-sonnet-4-6',
  },
  gemini: {
    default: GEMINI_MODEL,
  },
} as const;

/** Hard limits that protect cost, latency, and the Vercel request budget. */
export const LIMITS = {
  maxPagesPerJob: 50, // reject jobs larger than this
  maxImageBytes: 4_000_000, // stay under Vercel's ~4.5MB request body limit
  maxOutputTokens: MAX_TOKENS, // per page; dense pages are split on truncation
  perIpDailyPages: 30, // anti-abuse cap for the no-key (server-key) default
  concurrency: {
    anthropic: 3, // server-key / paid path
    geminiFree: 1, // free Gemini is 5 req/min — must run one at a time
  },
  geminiFreeSpacingMs: 13_000, // ~1 request / 13s keeps under 5 RPM
  imageLongEdgePx: 1300, // render target — high enough for small print, low latency
  imageJpegQuality: 0.8,
} as const;

/** Server-held keys. NEVER expose these to the client or write them to logs. */
export const serverKey = {
  anthropic: (): string => (process.env.ANTHROPIC_API_KEY ?? '').trim(),
  gemini: (): string => (process.env.GEMINI_API_KEY ?? '').trim(),
};
