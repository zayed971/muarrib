'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { t, dir, DEFAULT_LOCALE, otherLocale, type Locale } from '@/lib/i18n';
import type { LegalDoc } from '@/lib/legal';

export default function LegalPage({ doc }: { doc: LegalDoc }) {
  const [locale, setLocale] = useState<Locale>(DEFAULT_LOCALE);

  useEffect(() => {
    const saved = sessionStorage.getItem('muarrib-locale');
    if (saved === 'ar' || saved === 'en') setLocale(saved);
  }, []);
  useEffect(() => {
    document.documentElement.lang = locale;
    document.documentElement.dir = dir(locale);
  }, [locale]);

  return (
    <div className="wrap legal-page">
      <header className="legal-header">
        <Link href="/" className="about-link">{t('backToApp', locale)}</Link>
        <button
          type="button"
          className="about-link lang-toggle"
          onClick={() => setLocale(otherLocale(locale))}
        >
          <span aria-hidden="true">🌐</span> {t('switchLanguage', locale)}
        </button>
      </header>
      <h1>{doc.title[locale]}</h1>
      {doc.sections.map((section, i) => (
        <section key={i} className="legal-section">
          <h2>{section.heading[locale]}</h2>
          <p>{section.body[locale]}</p>
        </section>
      ))}
    </div>
  );
}
