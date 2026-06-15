/**
 * Typed, bilingual error system. Two jobs:
 *  1. Map any raw provider/SDK failure into a known category (classifyProviderError).
 *  2. Convert any thrown value into a safe API response that NEVER leaks internals
 *     and always gives the user a clear Arabic + English message (toApiError).
 *
 * Why it matters: today raw SDK error strings reach the user. This replaces them
 * with a small, predictable set of categories the UI can handle consistently.
 */

export type ErrorCode =
  | 'INVALID_INPUT'
  | 'RATE_LIMITED'
  | 'PROVIDER_AUTH'
  | 'PROVIDER_OVERLOADED'
  | 'PROVIDER_BLOCKED' // Gemini RECITATION / safety block
  | 'TRUNCATED'
  | 'PARSE_FAILED'
  | 'TIMEOUT'
  | 'VERIFICATION' // failed/absent bot check (Turnstile)
  | 'INTERNAL';

const STATUS: Record<ErrorCode, number> = {
  INVALID_INPUT: 400,
  RATE_LIMITED: 429,
  PROVIDER_AUTH: 401,
  PROVIDER_OVERLOADED: 503,
  PROVIDER_BLOCKED: 422,
  TRUNCATED: 422,
  PARSE_FAILED: 502,
  TIMEOUT: 504,
  VERIFICATION: 403,
  INTERNAL: 500,
};

export interface UserMessage {
  ar: string;
  en: string;
}

const MESSAGES: Record<ErrorCode, UserMessage> = {
  INVALID_INPUT: {
    ar: 'تعذّر قراءة الملف أو الصفحة. تأكد من أنه ملف PDF صالح.',
    en: "Could not read the file or page. Make sure it's a valid PDF.",
  },
  RATE_LIMITED: {
    ar: 'لقد بلغت الحد المسموح به الآن. انتظر قليلًا ثم أعد المحاولة، أو استخدم مفتاحك الخاص.',
    en: "You've hit the current limit. Wait a moment and retry, or use your own API key.",
  },
  PROVIDER_AUTH: {
    ar: 'مفتاح API غير صالح. تأكد من نسخه بشكل صحيح دون مسافات أو أرقام زائدة.',
    en: 'Invalid API key — check it\'s copied correctly with no extra spaces or characters.',
  },
  PROVIDER_OVERLOADED: {
    ar: 'خدمة الترجمة مشغولة حاليًا. أعد المحاولة بعد لحظات.',
    en: 'The translation service is busy right now. Try again in a moment.',
  },
  PROVIDER_BLOCKED: {
    ar: 'تعذّر على النموذج معالجة هذه الصفحة (قد تكون محتوى منشورًا معروفًا). جرّب مزوّدًا آخر مثل Anthropic.',
    en: "The model couldn't process this page (it may be recognized published content). Try another provider such as Anthropic.",
  },
  TRUNCATED: {
    ar: 'هذه الصفحة كثيفة جدًا واقتُطعت الترجمة؛ سيُعاد تقسيمها تلقائيًا.',
    en: 'This page was too dense and the translation was cut off; it will be split and retried.',
  },
  PARSE_FAILED: {
    ar: 'تعذّر تفسير ناتج الترجمة لهذه الصفحة. استخدم «إعادة المحاولة».',
    en: "Couldn't read the translation output for this page. Use Retry.",
  },
  TIMEOUT: {
    ar: 'استغرقت الترجمة وقتًا طويلًا. أعد المحاولة.',
    en: 'The translation took too long. Please retry.',
  },
  VERIFICATION: {
    ar: 'يرجى تحديث الصفحة وإكمال التحقق الأمني ثم المحاولة من جديد.',
    en: 'Please refresh the page and complete the security check, then try again.',
  },
  INTERNAL: {
    ar: 'حدث خطأ غير متوقع. أعد المحاولة.',
    en: 'An unexpected error occurred. Please retry.',
  },
};

export class AppError extends Error {
  readonly code: ErrorCode;
  /** Internal detail for logs only — never sent to the client. */
  readonly detail?: string;

  constructor(code: ErrorCode, detail?: string) {
    super(detail ?? code);
    this.name = 'AppError';
    this.code = code;
    this.detail = detail;
  }

  get status(): number {
    return STATUS[this.code];
  }

  get userMessage(): UserMessage {
    return MESSAGES[this.code];
  }
}

/** Turn a raw provider/SDK error into a categorized AppError. */
export function classifyProviderError(err: unknown): AppError {
  const raw = err instanceof Error ? err.message : String(err);
  const m = raw.toLowerCase();

  if (m.includes('recitation') || m.includes('blocked')) return new AppError('PROVIDER_BLOCKED', raw);
  if (m.includes('max_tokens') || m.includes('truncat')) return new AppError('TRUNCATED', raw);
  if (
    m.includes('401') ||
    m.includes('unauthorized') ||
    m.includes('access_token_type_unsupported') ||
    m.includes('api key not valid') ||
    m.includes('api_key_invalid') ||
    m.includes('403') ||
    m.includes('permission')
  ) {
    return new AppError('PROVIDER_AUTH', raw);
  }
  if (m.includes('429') || m.includes('too many requests') || m.includes('quota') || m.includes('rate limit')) {
    return new AppError('RATE_LIMITED', raw);
  }
  if (m.includes('503') || m.includes('overloaded') || m.includes('high demand') || m.includes('service unavailable')) {
    return new AppError('PROVIDER_OVERLOADED', raw);
  }
  if (m.includes('timeout') || m.includes('etimedout') || m.includes('aborted')) {
    return new AppError('TIMEOUT', raw);
  }
  return new AppError('INTERNAL', raw);
}

/** Safe API response for any thrown value. Internals never leak to the client. */
export function toApiError(err: unknown): {
  status: number;
  body: { error: UserMessage; code: ErrorCode };
} {
  const e = err instanceof AppError ? err : new AppError('INTERNAL', err instanceof Error ? err.message : String(err));
  return { status: e.status, body: { error: e.userMessage, code: e.code } };
}
