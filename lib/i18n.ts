/**
 * i18n — makes the interface Arabic-native.
 *
 * The output was already Arabic; this makes the *app itself* Arabic-first (the
 * default), with an optional English toggle. Every UI string lives here in both
 * languages, so the app never ships a half-translated screen. `satisfies Dict`
 * plus the parity test guarantee no key is missing a language.
 */

export const LOCALES = ['ar', 'en'] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'ar'; // Arabic-first for an Arab audience

export function dir(locale: Locale): 'rtl' | 'ltr' {
  return locale === 'ar' ? 'rtl' : 'ltr';
}

type Dict = Record<string, { ar: string; en: string }>;

export const STRINGS = {
  appName: { ar: 'مُعرِّب', en: 'Muʿarrib' },
  tagline: { ar: 'حوِّل ملفات PDF الإنجليزية إلى عربية سليمة وقابلة للقراءة', en: 'Turn English PDFs into clean, readable Arabic' },
  dropPdf: { ar: 'أفلِت ملف PDF هنا', en: 'Drop a PDF here' },
  orClick: { ar: 'أو اضغط للاختيار', en: 'or click to choose' },
  pagesToTranslate: { ar: 'الصفحات المراد ترجمتها', en: 'Pages to translate' },
  from: { ar: 'من', en: 'from' },
  to: { ar: 'إلى', en: 'to' },
  translate: { ar: 'ترجِم إلى العربية', en: 'Translate to Arabic' },
  translating: { ar: 'جارٍ الترجمة…', en: 'Translating…' },
  readingPage: { ar: 'تتم قراءة الصفحة', en: 'Reading page' },
  showOriginal: { ar: 'إظهار الأصل', en: 'Show original' },
  hideOriginal: { ar: 'إخفاء الأصل', en: 'Hide original' },
  showEnglishTerms: { ar: 'إظهار المصطلحات الإنجليزية', en: 'Show English terms' },
  exportLabel: { ar: 'تنزيل', en: 'Export' },
  exportWord: { ar: 'ملف وورد (.docx)', en: 'Word (.docx)' },
  exportHtml: { ar: 'صفحة ويب (.html)', en: 'Web page (.html)' },
  exportPdf: { ar: 'طباعة / PDF', en: 'Print / PDF' },
  retry: { ar: 'إعادة المحاولة', en: 'Retry' },
  newFile: { ar: 'ملف جديد', en: 'New file' },
  useGeminiFree: { ar: 'استخدم Gemini (مجاني — يكفي حساب Google)', en: 'Use Gemini (free — just a Google account)' },
  useAnthropicKey: { ar: 'لديّ مفتاح Anthropic', en: 'I have an Anthropic key' },
  apiKeyPlaceholder: { ar: 'ألصق مفتاحك هنا', en: 'Paste your key here' },
  confirmKey: { ar: 'تأكيد المفتاح', en: 'Confirm key' },
  keyActive: { ar: 'المفتاح مُفعَّل ✓', en: 'Key active ✓' },
  changeKey: { ar: 'تغيير', en: 'Change' },
  getGeminiKey: { ar: 'احصل على مفتاح Gemini مجاني', en: 'Get a free Gemini key' },
  geminiPrivacyWarning: {
    ar: 'قد تَستخدم خطة Gemini المجانية بياناتك لتحسين نماذج Google — لا تستخدمها للمستندات السرّية أو ملفات المرضى؛ استخدم Anthropic لتلك الملفات.',
    en: "Gemini's free tier may use your data to improve Google's models — don't use it for confidential or patient documents; use Anthropic for those.",
  },
  privacyNote: {
    ar: 'يبقى ملفك داخل متصفحك؛ تُرسَل صور الصفحات فقط لترجمتها، ولا نُخزِّن أي شيء.',
    en: 'Your file stays in your browser; only page images are sent to be translated, and we store nothing.',
  },
  hideEnglishTerms: { ar: 'إخفاء المصطلحات الإنجليزية', en: 'Hide English terms' },
  defaultProviderNote: {
    ar: 'الفئة المجانية الافتراضية تستخدم Claude (Anthropic) — الفئات المدفوعة لا تُستخدم لتدريب النماذج، مما يجعلها مناسبة للمستندات الطبية والقانونية والبحثية.',
    en: 'The default free tier uses Claude (Anthropic) — paid tiers are not used for model training, making it suitable for medical, legal, and research documents.',
  },
  dismiss: { ar: 'إغلاق', en: 'Dismiss' },
  backToApp: { ar: 'رجوع إلى التطبيق', en: 'Back to app' },
  uncertain: { ar: 'غير مؤكد — راجع الأصل', en: 'Uncertain — check the original' },
  numberWarning: { ar: 'تحقّق من الأرقام مقابل النص الأصلي', en: 'Check the numbers against the original' },
  verifyHuman: { ar: 'أكمِل التحقق الأمني للمتابعة', en: 'Complete the security check to continue' },
  pageLabel: { ar: 'صفحة', en: 'Page' },
  privacy: { ar: 'الخصوصية', en: 'Privacy' },
  terms: { ar: 'الشروط', en: 'Terms' },
  about: { ar: 'حول الأداة', en: 'About' },
  // The language toggle shows the language you'd switch TO.
  switchLanguage: { ar: 'English', en: 'العربية' },
} satisfies Dict;

export type StringKey = keyof typeof STRINGS;

/** Resolve a UI string for a locale (defaults to Arabic). */
export function t(key: StringKey, locale: Locale = DEFAULT_LOCALE): string {
  return STRINGS[key][locale];
}

/** The other locale — for a simple toggle. */
export function otherLocale(locale: Locale): Locale {
  return locale === 'ar' ? 'en' : 'ar';
}
