/**
 * Legal & trust content — bilingual, plain-language.
 *
 * The disclaimer is a SAFETY feature first (verify dosages) and legal cover
 * second. Privacy doubles as a selling point ("we store nothing"). This is an
 * honest baseline template, not formal legal advice — a lawyer should review
 * before a large public launch.
 */

export interface LegalSection {
  heading: { ar: string; en: string };
  body: { ar: string; en: string };
}
export interface LegalDoc {
  title: { ar: string; en: string };
  sections: LegalSection[];
}

/** Short notice for the disclaimer banner and the foot of every export. */
export const DISCLAIMER = {
  ar: 'هذه ترجمة آلية بمساعدة الذكاء الاصطناعي وقد تحتوي على أخطاء. يُرجى مراجعة الأرقام والجرعات والمصطلحات المهمة مقابل النص الأصلي. الأداة ليست بديلاً عن ترجمة احترافية أو استشارة طبية أو قانونية.',
  en: 'This is an AI-assisted machine translation and may contain errors. Please verify numbers, dosages, and key terms against the original. This tool is not a substitute for professional translation, medical, or legal advice.',
};

export const PRIVACY: LegalDoc = {
  title: { ar: 'سياسة الخصوصية', en: 'Privacy' },
  sections: [
    {
      heading: { ar: 'ملفك يبقى معك', en: 'Your file stays with you' },
      body: {
        ar: 'يُفتح ملف PDF ويُعرض داخل متصفحك. لا يُرفَع الملف كاملاً إلى خوادمنا في أي وقت.',
        en: 'Your PDF is opened and rendered inside your browser. The full file is never uploaded to our servers at any point.',
      },
    },
    {
      heading: { ar: 'ما الذي يُرسَل ولماذا', en: 'What is sent, and why' },
      body: {
        ar: 'تُرسَل صور الصفحات فقط إلى مزوّد الذكاء الاصطناعي الذي تختاره (Anthropic أو Google) لغرض الترجمة وحده.',
        en: 'Only individual page images are sent to the AI provider you choose (Anthropic or Google), solely to perform the translation.',
      },
    },
    {
      heading: { ar: 'ما الذي نُخزِّنه', en: 'What we store' },
      body: {
        ar: 'لا نُخزِّن مستنداتك ولا نحتفظ بسجلّ بمحتواها. قد نحفظ ترجمة صفحةٍ ما مرتبطةً ببصمة رقمية مُبهمة للصورة لتسريع الطلبات المتكرّرة وخفض التكلفة؛ ولا يمكن استرجاعها إلا لمن يملك الصورة نفسها.',
        en: "We do not store your documents or keep a record of their contents. We may cache a page's translation keyed to an opaque fingerprint of the image to speed up repeated requests and lower cost; it can only be retrieved by someone holding the identical source image.",
      },
    },
    {
      heading: { ar: 'مفتاح الـ API الخاص بك', en: 'Your API key' },
      body: {
        ar: 'إذا استخدمت مفتاحك الخاص، فإنه يُرسَل مع كل طلب لتنفيذ الترجمة فقط، ولا يُخزَّن على خوادمنا إطلاقاً.',
        en: 'If you use your own key, it is sent with each request only to perform the translation, and is never stored on our servers.',
      },
    },
    {
      heading: { ar: 'شروط المزوّدين', en: 'Provider terms' },
      body: {
        ar: 'تَخضع المعالجة لشروط المزوّد الذي تختاره. تنبيه: قد تَستخدم خطة Gemini المجانية بياناتك لتحسين نماذج Google؛ للمستندات السرّية استخدم Anthropic.',
        en: "Processing is subject to your chosen provider's terms. Note: Gemini's free tier may use your data to improve Google's models; for confidential documents, use Anthropic.",
      },
    },
  ],
};

export const TERMS: LegalDoc = {
  title: { ar: 'شروط الاستخدام', en: 'Terms of Use' },
  sections: [
    {
      heading: { ar: 'خدمة مجانية كما هي', en: 'A free service, as-is' },
      body: {
        ar: 'تُقدَّم هذه الأداة مجاناً وللمنفعة العامة «كما هي» دون أي ضمانات بشأن الدقة أو التوافر.',
        en: "This tool is provided free and for public benefit on an 'as-is' basis, without warranties as to accuracy or availability.",
      },
    },
    {
      heading: { ar: 'راجع المعلومات الحسّاسة', en: 'Verify critical information' },
      body: {
        ar: 'الترجمة آلية وقد تُخطئ. أنت مسؤول عن مراجعة الأرقام والجرعات والمحتوى الحسّاس مقابل النص الأصلي قبل الاعتماد عليه.',
        en: 'Translation is automated and may be wrong. You are responsible for verifying numbers, dosages, and sensitive content against the original before relying on it.',
      },
    },
    {
      heading: { ar: 'الاستخدام المقبول', en: 'Acceptable use' },
      body: {
        ar: 'لا تُستخدم الأداة لأي غرض غير قانوني، ولا تُترجِم محتوى لا تملك الحق في معالجته.',
        en: 'Do not use the tool for any unlawful purpose, and do not translate content you do not have the right to process.',
      },
    },
    {
      heading: { ar: 'حدود المسؤولية', en: 'Limitation of liability' },
      body: {
        ar: 'لا يتحمّل صانعو الأداة أي مسؤولية عن أضرار ناتجة عن استخدامها أو عن أخطاء في الترجمة، إلى أقصى حدٍّ يسمح به القانون.',
        en: 'To the maximum extent permitted by law, the makers of this tool are not liable for any damages arising from its use or from translation errors.',
      },
    },
  ],
};
