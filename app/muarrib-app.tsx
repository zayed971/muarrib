'use client';

import { useRef, useState, useCallback, useEffect } from 'react';
import Script from 'next/script';
import DOMPurify from 'dompurify';
import { escapeHtml } from '@/lib/sanitize';
import { findMissingNumbers } from '@/lib/number-guard';
import { Packer } from 'docx';
import { buildTranslationDoc } from '@/lib/export-docx';
import { buildTranslationHtml } from '@/lib/export-html';
import type { Block, TableCell as BlockTableCell } from '@/lib/types';
import { t, dir, DEFAULT_LOCALE, otherLocale, type Locale } from '@/lib/i18n';
import { DISCLAIMER } from '@/lib/legal';
import Link from 'next/link';

// ─── Model output is untrusted: escape HTML-significant characters, then run
// the assembled markup through DOMPurify as a second layer before it's used
// with dangerouslySetInnerHTML. SSR has no DOM, so pass the escaped HTML
// through unchanged there — it only ever renders once the client hydrates.
function sanitizeHtml(html: string): string {
  if (typeof window === 'undefined') return html;
  return DOMPurify.sanitize(html);
}

// ─── pdf.js minimal types (CDN global)
interface PdfViewport { width: number; height: number; }
interface PdfTextContent { items: Array<{ str?: string }>; }
interface PdfPage {
  getViewport(o: { scale: number }): PdfViewport;
  render(o: { canvasContext: CanvasRenderingContext2D; viewport: PdfViewport }): { promise: Promise<void> };
  getTextContent(): Promise<PdfTextContent>;
}
interface PdfDocument { numPages: number; getPage(n: number): Promise<PdfPage>; }
declare global {
  interface Window {
    pdfjsLib: {
      GlobalWorkerOptions: { workerSrc: string };
      getDocument(o: { data: ArrayBuffer }): { promise: Promise<PdfDocument> };
    };
    turnstile?: {
      render(container: string | HTMLElement, options: {
        sitekey: string;
        callback: (token: string) => void;
        'error-callback'?: () => void;
        'expired-callback'?: () => void;
      }): string;
      reset(widgetId?: string): void;
    };
  }
}

// ─── App types
type Provider = 'anthropic' | 'gemini';
type KeyStatus = 'unverified' | 'verifying' | 'verified' | 'invalid';
type PageStatus = 'pending' | 'done' | 'failed';
interface PageState {
  num: number;
  status: PageStatus;
  image: string | null;
  blocks: Block[] | null;
  error: string | null;
  /** Numbers found in the page's text layer but missing from the translation. */
  numberWarning: string[] | null;
}

// ─── Constants
const CONCURRENCY = 3;
// Free Gemini keys are capped at 5 requests/minute — go one at a time, spaced
// to stay safely under that, instead of bursting and hitting 429s.
const GEMINI_CONCURRENCY = 1;
const GEMINI_SPACING_MS = 13_000;
const TARGET_LONG_EDGE = 1300;
const JPEG_QUALITY = 0.8;
const WARN_ABOVE = 40;
const PDF_SRC = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
const PDF_WORKER = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
const TURNSTILE_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js';

// ─── Utility: render one PDF page to a JPEG data-URL (browser-side, no upload)
async function renderPageImage(doc: PdfDocument, num: number): Promise<string> {
  const page = await doc.getPage(num);
  const base = page.getViewport({ scale: 1 });
  let scale = TARGET_LONG_EDGE / Math.max(base.width, base.height);
  scale = Math.max(1.0, Math.min(3.5, scale));
  const vp = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(vp.width);
  canvas.height = Math.ceil(vp.height);
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  const url = canvas.toDataURL('image/jpeg', JPEG_QUALITY);
  canvas.width = canvas.height = 0; // release memory
  return url;
}

// ─── Utility: extract the PDF's text-layer for a page (English source text).
// Used as the ground truth for the number cross-check below.
async function getPageText(doc: PdfDocument, num: number): Promise<string> {
  const page = await doc.getPage(num);
  const content = await page.getTextContent();
  return content.items.map(it => it.str ?? '').join(' ');
}

// ─── Utility: flatten a translated block array into one string for the number
// cross-check (table cells, list items, headings, etc.).
function blocksToText(blocks: Block[]): string {
  const cellText = (cell: BlockTableCell): string => (typeof cell === 'string' ? cell : cell.ar ?? '');
  const parts: string[] = [];
  for (const b of blocks) {
    if (b.ar) parts.push(b.ar);
    if (b.content) parts.push(b.content);
    if (b.items) parts.push(...b.items);
    if (b.rows) for (const row of b.rows) parts.push(...row.map(cellText));
  }
  return parts.join(' ');
}

// ─── Utility: trigger a browser download for a Blob
function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ─── Utility: split a JPEG data-URL vertically into top and bottom halves
async function splitImageVertically(dataUrl: string): Promise<[string, string]> {
  return new Promise((resolve, reject) => {
    const img = new window.Image();
    img.onload = () => {
      const { width: w, height: h } = img;
      const half = Math.floor(h / 2);

      const slice = (sy: number, sh: number): string => {
        const c = document.createElement('canvas');
        c.width = w;
        c.height = sh;
        const ctx = c.getContext('2d')!;
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, w, sh);
        ctx.drawImage(img, 0, sy, w, sh, 0, 0, w, sh);
        const url = c.toDataURL('image/jpeg', JPEG_QUALITY);
        c.width = c.height = 0;
        return url;
      };

      resolve([slice(0, half), slice(half, h - half)]);
    };
    img.onerror = reject;
    img.src = dataUrl;
  });
}

// ─── Utility: call the backend proxy
// apiKey is empty when using the server's key (default/free mode).
async function callProxy(
  dataUrl: string,
  pageNum: number,
  provider: Provider,
  apiKey: string,
  locale: Locale,
): Promise<{ blocks: Block[]; truncated: boolean; parseFailed: boolean }> {
  const imageBase64 = dataUrl.split(',')[1];
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers['x-user-api-key'] = apiKey;
  const res = await fetch('/api/translate-page', {
    method: 'POST',
    headers,
    body: JSON.stringify({ imageBase64, pageNum, provider }),
  });
  const data: {
    blocks?: Block[];
    error?: { ar: string; en: string };
    code?: string;
    truncated?: boolean;
    parseFailed?: boolean;
  } = await res.json();
  if (!res.ok || data.error) {
    const e = new Error(data.error?.[locale] ?? `HTTP ${res.status}`);
    if (data.code === 'RATE_LIMITED') (e as Error & { rateLimited: boolean }).rateLimited = true;
    if (data.code === 'VERIFICATION') (e as Error & { verificationFailed: boolean }).verificationFailed = true;
    throw e;
  }
  return { blocks: data.blocks ?? [], truncated: data.truncated ?? false, parseFailed: data.parseFailed ?? false };
}

// ─── Utility: bounded concurrency pool, with optional spacing between calls
// (used to keep free Gemini keys under their 5 requests/minute cap)
async function runPool<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
  spacingMs = 0,
): Promise<void> {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        if (i > 0 && spacingMs > 0) await new Promise(r => setTimeout(r, spacingMs));
        await fn(items[i++]);
      }
    }),
  );
}

// ─── Process one page: render image → ONE normal call → only on truncation or
// a parse failure, retry that page by splitting it into top/bottom halves and
// merging the resulting blocks in order → update state
async function processOnePage(
  num: number,
  doc: PdfDocument,
  provider: Provider,
  apiKey: string,
  locale: Locale,
  imageCache: Map<number, string>,
  onUpdate: (num: number, patch: Partial<PageState>) => void,
  onRateLimit?: () => void,
  onVerificationFailed?: () => void,
): Promise<void> {
  try {
    let image = imageCache.get(num) ?? null;
    if (!image) {
      image = await renderPageImage(doc, num);
      imageCache.set(num, image);
      onUpdate(num, { image });
    }

    const { blocks, truncated, parseFailed } = await callProxy(image, num, provider, apiKey, locale);

    let finalBlocks: Block[];
    if (truncated || parseFailed) {
      // Hit the token limit or returned unparseable JSON — split into top/bottom
      // halves, translate each separately, and merge in reading order
      const [topUrl, botUrl] = await splitImageVertically(image);
      const [topResult, botResult] = await Promise.all([
        callProxy(topUrl, num, provider, apiKey, locale),
        callProxy(botUrl, num, provider, apiKey, locale),
      ]);
      finalBlocks = [...topResult.blocks, ...botResult.blocks];
    } else {
      finalBlocks = blocks;
    }

    // Number cross-check: flag numbers present in the PDF's text layer but
    // missing from the translation, so the user can verify against the original.
    let numberWarning: string[] | null = null;
    try {
      const sourceText = await getPageText(doc, num);
      const { ok, missing } = findMissingNumbers(sourceText, blocksToText(finalBlocks));
      if (!ok) numberWarning = missing;
    } catch {
      // text-layer extraction is best-effort — never block on it
    }

    onUpdate(num, { status: 'done', blocks: finalBlocks, error: null, numberWarning });
  } catch (err) {
    if ((err as { rateLimited?: boolean }).rateLimited) onRateLimit?.();
    if ((err as { verificationFailed?: boolean }).verificationFailed) onVerificationFailed?.();
    onUpdate(num, {
      status: 'failed',
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ─── Block rendering
type TableCell = { ar: string; en?: string } | string;

// Build sanitized inner-HTML for a table cell: escaped Arabic text, plus an
// optional escaped English term in parentheses when "Show English terms" is on.
function cellHtml(cell: TableCell, showEnglish: boolean): string {
  const c = typeof cell === 'object' && cell !== null ? cell : { ar: String(cell ?? '') };
  let html = escapeHtml(c.ar ?? '');
  if (showEnglish && c.en) html += `<bdi class="term-en">(${escapeHtml(c.en)})</bdi>`;
  return sanitizeHtml(html);
}

function BlockItem({ block, showEnglish, locale }: { block: Block; showEnglish: boolean; locale: Locale }) {
  let inner: React.ReactNode;

  switch (block.type) {
    case 'heading': {
      let html = escapeHtml(block.ar ?? '');
      if (showEnglish && block.en) html += `<span class="en">${escapeHtml(block.en)}</span>`;
      inner = <h3 className="b-h" dangerouslySetInnerHTML={{ __html: sanitizeHtml(html) }} />;
      break;
    }
    case 'subheading': {
      let html = escapeHtml(block.ar ?? '');
      if (showEnglish && block.en) html += `<span class="en">${escapeHtml(block.en)}</span>`;
      inner = <h4 className="b-sh" dangerouslySetInnerHTML={{ __html: sanitizeHtml(html) }} />;
      break;
    }
    case 'paragraph':
      inner = <p className="b-p" dangerouslySetInnerHTML={{ __html: sanitizeHtml(escapeHtml(block.ar ?? '')) }} />;
      break;
    case 'list': {
      const html = (block.items ?? []).map(it => `<li>${escapeHtml(it)}</li>`).join('');
      inner = <ul className="b-list" dangerouslySetInnerHTML={{ __html: sanitizeHtml(html) }} />;
      break;
    }
    case 'caption':
      inner = <p className="b-cap" dangerouslySetInnerHTML={{ __html: sanitizeHtml(escapeHtml(block.ar ?? '')) }} />;
      break;
    case 'figure':
      inner = (
        <div className="b-figure">
          <div className="ftop">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <circle cx="9" cy="9" r="2" />
              <path d="m21 15-3.6-3.6a2 2 0 0 0-2.8 0L4 22" />
            </svg>
            شكل / رسم بياني
          </div>
          <div className="fdesc" dangerouslySetInnerHTML={{ __html: sanitizeHtml(escapeHtml(block.ar ?? '')) }} />
          <div className="hint">اضغط «Show original» لرؤية الشكل الأصلي.</div>
        </div>
      );
      break;
    case 'equation':
      inner = (
        <div
          className="b-eq"
          dir="ltr"
          dangerouslySetInnerHTML={{ __html: sanitizeHtml(escapeHtml(block.content ?? block.ar ?? '')) }}
        />
      );
      break;
    case 'code':
      inner = (
        <pre
          className="b-code"
          dir="ltr"
          dangerouslySetInnerHTML={{ __html: sanitizeHtml(escapeHtml(block.content ?? block.ar ?? '')) }}
        />
      );
      break;
    case 'table': {
      const rows = block.rows ?? [];
      inner = (
        <div className="table-scroll">
          <table className="b-table" dir="rtl">
            {rows.length > 0 && (
              <thead>
                <tr>
                  {(rows[0] ?? []).map((cell, ci) => (
                    <th key={ci} dangerouslySetInnerHTML={{ __html: cellHtml(cell as TableCell, showEnglish) }} />
                  ))}
                </tr>
              </thead>
            )}
            <tbody>
              {rows.slice(1).map((row, ri) => (
                <tr key={ri}>
                  {(row ?? []).map((cell, ci) => (
                    <td key={ci} dangerouslySetInnerHTML={{ __html: cellHtml(cell as TableCell, showEnglish) }} />
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
      break;
    }
    default:
      inner = block.ar
        ? <p className="b-p" dangerouslySetInnerHTML={{ __html: sanitizeHtml(escapeHtml(block.ar)) }} />
        : null;
  }

  if (!inner) return null;

  if (block.lowconf) {
    return (
      <div className="lowconf">
        <span className="lc-tag">{t('uncertain', locale)}</span>
        {inner}
      </div>
    );
  }
  return <>{inner}</>;
}

function BlocksView({ blocks, showEnglish, locale }: { blocks: Block[]; showEnglish: boolean; locale: Locale }) {
  if (!blocks.length) {
    return (
      <p className="b-cap">
        لا يوجد نص قابل للترجمة في هذه الصفحة (غلاف، صفحة فارغة، أو صورة فقط).
      </p>
    );
  }
  return (
    <>
      {blocks.map((b, i) => <BlockItem key={i} block={b} showEnglish={showEnglish} locale={locale} />)}
    </>
  );
}

// ─── Key field: input + Confirm/locked states for BYOK verification
function KeyField({
  placeholder, value, status, error, running, linkHref, linkLabel, onInput, onConfirm, onChangeKey, locale,
}: {
  placeholder: string;
  value: string;
  status: KeyStatus;
  error: string;
  running: boolean;
  linkHref: string;
  linkLabel: string;
  onInput: (v: string) => void;
  onConfirm: () => void;
  onChangeKey: () => void;
  locale: Locale;
}) {
  const verified = status === 'verified';
  const verifying = status === 'verifying';
  return (
    <>
      <div className="key-row">
        <input
          type="password"
          className={`key-input${verified ? ' locked' : ''}`}
          placeholder={placeholder}
          value={value}
          onChange={e => onInput(e.target.value)}
          disabled={running || verified || verifying}
          readOnly={verified}
          autoComplete="off"
        />
        {verified ? (
          <>
            <span className="key-active">{t('keyActive', locale)}</span>
            <button type="button" className="link-btn" onClick={onChangeKey} disabled={running}>
              {t('changeKey', locale)}
            </button>
          </>
        ) : (
          <button
            type="button"
            className="btn ghost confirm-btn"
            onClick={onConfirm}
            disabled={running || !value.trim() || verifying}
          >
            {verifying ? (locale === 'ar' ? 'جارٍ التحقق…' : 'Checking…') : t('confirmKey', locale)}
          </button>
        )}
        <a className="key-link" href={linkHref} target="_blank" rel="noopener noreferrer">{linkLabel}</a>
      </div>
      {status === 'invalid' && error && <div className="key-error">{error}</div>}
    </>
  );
}

// ─── Main component
export default function MuarribApp() {
  // PDF state
  const [pdfDoc, setPdfDoc] = useState<PdfDocument | null>(null);
  const [fileName, setFileName] = useState('');
  const [numPages, setNumPages] = useState(0);
  const [fileSize, setFileSize] = useState('');
  const [fromPage, setFromPage] = useState(1);
  const [toPage, setToPage] = useState(1);
  const [loadError, setLoadError] = useState('');
  const [dragging, setDragging] = useState(false);

  // Translation state
  const [pages, setPages] = useState<PageState[]>([]);
  const [running, setRunning] = useState(false);
  const [showOriginal, setShowOriginal] = useState(false);
  const [showEnglish, setShowEnglish] = useState(false);
  const [label, setLabel] = useState<{ fileName: string; from: number; to: number } | null>(null);

  const [aboutOpen, setAboutOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const exportRef = useRef<HTMLDivElement>(null);

  // Interface language (independent of the always-Arabic translation output)
  const [locale, setLocale] = useState<Locale>(DEFAULT_LOCALE);
  const [disclaimerDismissed, setDisclaimerDismissed] = useState(false);

  // Advanced / BYOK state (collapsed by default — default mode needs no key)
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [byokProvider, setByokProvider] = useState<Provider>('gemini');
  const [byokKey, setByokKey] = useState('');
  const [keyStatus, setKeyStatus] = useState<KeyStatus>('unverified');
  const [keyError, setKeyError] = useState('');
  const [rateLimitHit, setRateLimitHit] = useState(false);

  // Cloudflare Turnstile (bot check for the free server-key path)
  const [verified, setVerified] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [verifyError, setVerifyError] = useState('');

  const fileInputRef = useRef<HTMLInputElement>(null);
  const imageCache = useRef<Map<number, string>>(new Map());
  const turnstileRef = useRef<HTMLDivElement>(null);
  const turnstileWidgetId = useRef<string | null>(null);

  // ─── Remember the "show English terms" choice for this browser session
  useEffect(() => {
    if (sessionStorage.getItem('muarrib-show-english') === 'true') setShowEnglish(true);
  }, []);
  useEffect(() => {
    sessionStorage.setItem('muarrib-show-english', String(showEnglish));
  }, [showEnglish]);

  // ─── Remember the interface language for this browser session, and keep
  // <html lang/dir> in sync (set imperatively — RootLayout is a server component
  // and can't see this client-side state).
  useEffect(() => {
    const saved = sessionStorage.getItem('muarrib-locale');
    if (saved === 'ar' || saved === 'en') setLocale(saved);
  }, []);
  useEffect(() => {
    sessionStorage.setItem('muarrib-locale', locale);
    document.documentElement.lang = locale;
    document.documentElement.dir = dir(locale);
  }, [locale]);

  // ─── Helpers
  const clamp = useCallback(() => {
    const f = Math.max(1, Math.min(fromPage || 1, numPages));
    const t = Math.max(f, Math.min(toPage || 1, numPages));
    return { from: f, to: t, count: t - f + 1 };
  }, [fromPage, toPage, numPages]);

  const updatePage = useCallback((num: number, patch: Partial<PageState>) => {
    setPages(prev => prev.map(p => p.num === num ? { ...p, ...patch } : p));
  }, []);

  const resetOutput = useCallback(() => {
    setPages([]);
    setShowOriginal(false);
    setLabel(null);
  }, []);

  // ─── Close the export menu on outside click
  useEffect(() => {
    if (!exportOpen) return;
    const onClick = (e: MouseEvent) => {
      if (exportRef.current && !exportRef.current.contains(e.target as Node)) setExportOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [exportOpen]);

  // ─── All successfully-translated pages' blocks, in page order
  const allBlocks = pages
    .filter(p => p.status === 'done' && p.blocks != null)
    .flatMap(p => p.blocks as Block[]);

  const exportBaseName = (fileName.replace(/\.[^./]+$/, '') || 'translation');

  const exportWord = useCallback(async () => {
    const blob = await Packer.toBlob(buildTranslationDoc(allBlocks, { title: fileName, showEnglishTerms: showEnglish }));
    downloadBlob(blob, `${exportBaseName}-ar.docx`);
    setExportOpen(false);
  }, [allBlocks, fileName, showEnglish, exportBaseName]);

  const exportHtmlFile = useCallback(() => {
    const html = buildTranslationHtml(allBlocks, { title: fileName, showEnglishTerms: showEnglish });
    downloadBlob(new Blob([html], { type: 'text/html' }), `${exportBaseName}-ar.html`);
    setExportOpen(false);
  }, [allBlocks, fileName, showEnglish, exportBaseName]);

  const exportPdf = useCallback(() => {
    setExportOpen(false);
    window.print();
  }, []);

  // ─── BYOK key verification
  const handleKeyInput = useCallback((value: string) => {
    setByokKey(value);
    setKeyStatus('unverified');
    setKeyError('');
  }, []);

  const handleProviderChange = useCallback((p: Provider) => {
    setByokProvider(p);
    setByokKey('');
    setKeyStatus('unverified');
    setKeyError('');
  }, []);

  const changeKey = useCallback(() => {
    setKeyStatus('unverified');
    setKeyError('');
  }, []);

  // ─── Turnstile bot-check (only required for the free server-key path)
  const verify = useCallback(async (token: string) => {
    setVerifying(true);
    setVerifyError('');
    try {
      const res = await fetch('/api/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      const data: { ok?: boolean; error?: { en: string } } = await res.json();
      if (data.ok) {
        setVerified(true);
      } else {
        setVerified(false);
        setVerifyError(data.error?.en ?? 'Security check failed — please try again.');
        if (turnstileWidgetId.current) window.turnstile?.reset(turnstileWidgetId.current);
      }
    } catch {
      setVerified(false);
      setVerifyError("Couldn't reach the server to verify — check your connection.");
      if (turnstileWidgetId.current) window.turnstile?.reset(turnstileWidgetId.current);
    } finally {
      setVerifying(false);
    }
  }, []);

  const handleVerificationFailed = useCallback(() => {
    setVerified(false);
    setVerifyError('Security check expired — please verify again.');
    if (turnstileWidgetId.current) window.turnstile?.reset(turnstileWidgetId.current);
  }, []);

  const confirmKey = useCallback(async () => {
    const trimmed = byokKey.trim();
    if (!trimmed) return;

    const prefix = byokProvider === 'gemini' ? 'AIza' : 'sk-ant-';
    if (!trimmed.startsWith(prefix)) {
      setKeyStatus('invalid');
      setKeyError(
        `This doesn't look like a valid key — ${byokProvider === 'gemini' ? 'Gemini' : 'Anthropic'} keys start with "${prefix}".`
      );
      return;
    }

    setKeyStatus('verifying');
    setKeyError('');
    try {
      const res = await fetch('/api/verify-key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-user-api-key': trimmed },
        body: JSON.stringify({ provider: byokProvider }),
      });
      const data: { valid?: boolean; error?: string } = await res.json();
      if (data.valid) {
        setByokKey(trimmed);
        setKeyStatus('verified');
      } else {
        setKeyStatus('invalid');
        setKeyError(data.error ?? 'Key rejected — double-check it.');
      }
    } catch {
      setKeyStatus('invalid');
      setKeyError("Couldn't reach the server to verify — check your connection and try again.");
    }
  }, [byokKey, byokProvider]);

  // ─── File loading
  const loadFile = useCallback(async (file: File | null | undefined) => {
    if (!file) return;
    setLoadError('');
    if (file.type !== 'application/pdf' && !/\.pdf$/i.test(file.name)) {
      setLoadError("That doesn't look like a PDF. Please choose a .pdf file.");
      return;
    }
    if (!window.pdfjsLib) {
      setLoadError('The PDF engine didn\'t load (network blocked the CDN). Reload the page.');
      return;
    }
    // Defensive: the Script onLoad sets this, but a cached script can fire its
    // load event before the handler is attached, leaving it unset.
    if (!window.pdfjsLib.GlobalWorkerOptions.workerSrc) {
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDF_WORKER;
    }
    try {
      const buf = await file.arrayBuffer();
      const doc = await window.pdfjsLib.getDocument({ data: buf }).promise;
      setPdfDoc(doc);
      setFileName(file.name);
      setNumPages(doc.numPages);
      setFileSize((file.size / 1024 / 1024).toFixed(1) + ' MB');
      setFromPage(1);
      setToPage(Math.min(doc.numPages, 10));
      resetOutput();
    } catch (err) {
      setLoadError(
        'Couldn\'t open this PDF. It may be encrypted or corrupted. (' +
        (err instanceof Error ? err.message : String(err)) + ')',
      );
    }
  }, [resetOutput]);

  const reset = useCallback(() => {
    setPdfDoc(null);
    setFileName('');
    setNumPages(0);
    setFileSize('');
    setLoadError('');
    if (fileInputRef.current) fileInputRef.current.value = '';
    resetOutput();
  }, [resetOutput]);

  // ─── Translation
  const run = useCallback(async () => {
    if (running || !pdfDoc) return;
    const keyEntered = byokKey.trim().length > 0;
    if (keyEntered && keyStatus !== 'verified') return; // unverified BYOK key — block translation
    const usByok = keyStatus === 'verified';
    if (!usByok && !verified) return; // security check not completed — block translation
    const prov: Provider = usByok ? byokProvider : 'anthropic';
    const key = usByok ? byokKey.trim() : '';
    setRateLimitHit(false);
    const { from, to, count } = clamp();
    const nums = Array.from({ length: count }, (_, i) => from + i);

    imageCache.current = new Map();
    setPages(nums.map(n => ({ num: n, status: 'pending', image: null, blocks: null, error: null, numberWarning: null })));
    setShowOriginal(false);
    setRunning(true);
    setLabel({ fileName, from, to });

    const doc = pdfDoc;
    const cache = imageCache.current;

    // Server-key/Anthropic mode can run 3 at a time; a free Gemini key is
    // capped at 5 requests/minute, so go one at a time with ~13s spacing.
    const limit = prov === 'gemini' ? GEMINI_CONCURRENCY : CONCURRENCY;
    const spacing = prov === 'gemini' ? GEMINI_SPACING_MS : 0;

    await runPool(nums, limit, num =>
      processOnePage(num, doc, prov, key, locale, cache, updatePage, () => setRateLimitHit(true), handleVerificationFailed),
      spacing,
    );
    setRunning(false);
  }, [running, pdfDoc, byokKey, byokProvider, keyStatus, verified, fileName, locale, clamp, updatePage, handleVerificationFailed]);

  const retryPage = useCallback(async (num: number) => {
    if (!pdfDoc) return;
    const keyEntered = byokKey.trim().length > 0;
    if (keyEntered && keyStatus !== 'verified') return;
    const usByok = keyStatus === 'verified';
    const prov: Provider = usByok ? byokProvider : 'anthropic';
    const key = usByok ? byokKey.trim() : '';
    updatePage(num, { status: 'pending', error: null, numberWarning: null });
    await processOnePage(num, pdfDoc, prov, key, locale, imageCache.current, updatePage, () => setRateLimitHit(true), handleVerificationFailed);
  }, [pdfDoc, byokKey, byokProvider, keyStatus, locale, updatePage, handleVerificationFailed]);

  // ─── Derived
  const usingByok = keyStatus === 'verified';
  const keyEntered = byokKey.trim().length > 0;
  const blockedByUnverifiedKey = keyEntered && keyStatus !== 'verified';
  const blockedByVerification = !usingByok && !verified;
  const range = clamp();
  const finished = pages.filter(p => p.status === 'done' || p.status === 'failed').length;
  const failed = pages.filter(p => p.status === 'failed').length;
  const progressPct = pages.length ? (finished / pages.length) * 100 : 0;
  const progressText = pages.length === 0
    ? ''
    : finished < pages.length
    ? (locale === 'ar'
        ? `${t('readingPage', locale)} ${finished} من ${pages.length}…`
        : `${t('readingPage', locale)} ${finished} of ${pages.length}…`)
    : (locale === 'ar'
        ? `تم — تُرجمت ${pages.length - failed} من ${pages.length} صفحة${failed ? ` · فشلت ${failed} (أعِد المحاولة أدناه)` : ''}.`
        : `Done — ${pages.length - failed} of ${pages.length} page${pages.length === 1 ? '' : 's'} translated${failed ? ` · ${failed} failed (retry below)` : ''}.`);

  // ─── Render
  return (
    <>
      <Script
        src={PDF_SRC}
        strategy="afterInteractive"
        onLoad={() => {
          // Cached scripts can fire onLoad in odd orders — guard against
          // window.pdfjsLib not being defined yet to avoid an uncaught
          // TypeError that would crash the whole app.
          if (window.pdfjsLib) {
            window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDF_WORKER;
          }
        }}
      />

      <Script
        src={TURNSTILE_SRC}
        strategy="afterInteractive"
        onLoad={() => {
          if (window.turnstile && turnstileRef.current && !turnstileWidgetId.current) {
            turnstileWidgetId.current = window.turnstile.render(turnstileRef.current, {
              sitekey: process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY ?? '',
              callback: verify,
              'error-callback': () => {
                setVerified(false);
                setVerifyError('Security check failed to load. Reload the page.');
              },
              'expired-callback': () => setVerified(false),
            });
          }
        }}
      />

      <div className="wrap">
        {/* ── Header ── */}
        <header>
          <div className="brand">
            <span className="mark">مُعرِّب</span>
            <h1><span className="latin-name">Muʿarrib</span></h1>
            <button type="button" className="about-link" onClick={() => setAboutOpen(true)}>
              <span aria-hidden="true">ⓘ</span> {t('about', locale)}
            </button>
            <button
              type="button"
              className="about-link lang-toggle"
              onClick={() => setLocale(otherLocale(locale))}
            >
              <span aria-hidden="true">🌐</span> {t('switchLanguage', locale)}
            </button>
          </div>
          <p className="tagline">
            {locale === 'ar'
              ? 'ملفات PDF إنجليزية، تُقرأ بعربية حقيقية — حروف متصلة، اتجاه صحيح، جداول مُعاد بناؤها. كما يقرؤها إنسان، بمساعدة نموذج رؤية.'
              : 'English PDFs, read in real Arabic — letters connected, direction correct, tables rebuilt. The kind a vision model reads the way a person does.'}
          </p>
          <div className="how">
            {(locale === 'ar'
              ? ['ارفع ملف PDF إنجليزي', 'اختر الصفحات', 'تَرجِم — يقرأ الذكاء الاصطناعي كل صفحة كصورة', 'اقرأ، قارِن بالأصل، أو احفظ']
              : ['Upload an English PDF', 'Choose pages', 'Translate — the AI reads each page as an image', 'Read, compare to the original, or save']
            ).map((s, i) => (
              <span key={i} className="step">
                <span className="n">{i + 1}</span> {s}
              </span>
            ))}
          </div>
        </header>

        {/* ── Uploader ── */}
        <div
          className={`uploader${pdfDoc ? ' hidden' : ''}${dragging ? ' drag' : ''}`}
          role="button"
          tabIndex={0}
          aria-label="Upload a PDF"
          onClick={() => fileInputRef.current?.click()}
          onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInputRef.current?.click(); } }}
          onDragEnter={e => { e.preventDefault(); setDragging(true); }}
          onDragOver={e => { e.preventDefault(); setDragging(true); }}
          onDragLeave={e => { e.preventDefault(); setDragging(false); }}
          onDrop={e => {
            e.preventDefault();
            setDragging(false);
            loadFile(e.dataTransfer.files?.[0]);
          }}
        >
          <div className="ico">
            <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <path d="M14 2v6h6" />
              <path d="M12 18v-6" />
              <path d="m9 15 3-3 3 3" />
            </svg>
          </div>
          <div className="big">{t('dropPdf', locale)}</div>
          <div className="sub">
            {t('orClick', locale)}
            {locale === 'ar' ? ' — يبقى في متصفحك حتى تبدأ الترجمة' : ' — stays in your browser until you translate'}
          </div>
          {loadError && <div className="err">{loadError}</div>}
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept="application/pdf"
          style={{ display: 'none' }}
          onChange={e => loadFile(e.target.files?.[0])}
        />

        {/* ── Controls ── */}
        <div className={`controls${pdfDoc ? ' show' : ''}`}>
          <div className="ctrl-head">
            <span className="doc-ico">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <path d="M14 2v6h6" />
              </svg>
            </span>
            <div>
              <div className="fname">{fileName}</div>
              <div className="meta">{numPages} page{numPages === 1 ? '' : 's'} · {fileSize}</div>
            </div>
            <div className="spacer" />
            <button className="btn ghost" onClick={reset} disabled={running}>{t('newFile', locale)}</button>
          </div>
          <div className="ctrl-body">
            <div className="field">
              <label>{t('pagesToTranslate', locale)}</label>
              <div className="range-inputs">
                <span>{t('from', locale)}</span>
                <input
                  type="number"
                  value={fromPage}
                  min={1}
                  max={numPages}
                  onChange={e => setFromPage(parseInt(e.target.value, 10) || 1)}
                  onBlur={() => { const r = clamp(); setFromPage(r.from); setToPage(r.to); }}
                  disabled={running}
                />
                <span>{t('to', locale)}</span>
                <input
                  type="number"
                  value={toPage}
                  min={1}
                  max={numPages}
                  onChange={e => setToPage(parseInt(e.target.value, 10) || 1)}
                  onBlur={() => { const r = clamp(); setFromPage(r.from); setToPage(r.to); }}
                  disabled={running}
                />
              </div>
            </div>
            <div className="estimate">
              {locale === 'ar' ? (
                <><b>{range.count}</b> صفحة ← <b>{range.count}</b> طلب{range.count === 1 ? '' : 'ات'} للذكاء الاصطناعي.</>
              ) : (
                <><b>{range.count}</b> page{range.count === 1 ? '' : 's'} → <b>{range.count}</b> AI call{range.count === 1 ? '' : 's'}.</>
              )}
              {range.count > WARN_ABOVE && (
                <span className="warn">
                  {locale === 'ar'
                    ? ' المهام الكبيرة أبطأ وأعلى تكلفة — جرّب فصلاً واحداً أولاً.'
                    : ' Large jobs are slower & cost more — try a chapter first.'}
                </span>
              )}
            </div>
            <div className="spacer" />
            <button
              className="btn primary"
              onClick={run}
              disabled={running || !pdfDoc || blockedByUnverifiedKey || blockedByVerification}
            >
              {running ? t('translating', locale) : t('translate', locale)}
            </button>
            {blockedByUnverifiedKey && (
              <div className="key-block-hint">
                {keyStatus === 'verifying'
                  ? (locale === 'ar' ? 'جارٍ التحقق من مفتاحك…' : 'Verifying your key…')
                  : (locale === 'ar'
                      ? 'أكِّد مفتاح API في الإعدادات المتقدمة أدناه لاستخدامه — أو أزِله لاستخدام الإعداد المجاني الافتراضي.'
                      : 'Confirm your API key in Advanced settings below to translate with it — or clear it to use the free default.')}
              </div>
            )}
            {!blockedByUnverifiedKey && blockedByVerification && (
              <div className="key-block-hint">
                {verifying
                  ? (locale === 'ar' ? 'جارٍ التحقق…' : 'Verifying…')
                  : t('verifyHuman', locale)}
              </div>
            )}
          </div>
          {!usingByok && (
            <div className="turnstile-wrap">
              <div ref={turnstileRef} />
              {verifyError && <div className="key-error">{verifyError}</div>}
            </div>
          )}
        </div>

        {/* ── Rate-limit banner ── */}
        {rateLimitHit && !usingByok && (
          <div className="rate-limit-banner">
            {locale === 'ar' ? (
              <>
                <b>تم الوصول إلى الحد اليومي المجاني.</b> لقد استهلكت حصتك المجانية من الصفحات على المفتاح المشترك لهذا اليوم.{' '}
                <button className="link-btn" onClick={() => setAdvancedOpen(true)}>
                  أضف مفتاح API الخاص بك
                </button>{' '}
                في الإعدادات المتقدمة أدناه للمتابعة، أو عُد غداً.
              </>
            ) : (
              <>
                <b>Free daily limit reached.</b> You&apos;ve hit today&apos;s free-page limit on the shared key.{' '}
                <button className="link-btn" onClick={() => setAdvancedOpen(true)}>
                  Add your own API key
                </button>{' '}
                in Advanced Settings below to keep going, or come back tomorrow.
              </>
            )}
          </div>
        )}

        {/* ── Advanced: BYOK ── */}
        <div className="advanced-section">
          <button
            className="advanced-toggle"
            onClick={() => setAdvancedOpen(v => !v)}
            aria-expanded={advancedOpen}
            disabled={running}
          >
            <span className="adv-arrow">{advancedOpen ? '▲' : '▼'}</span>
            {locale === 'ar' ? 'متقدّم — استخدم مفتاح API الخاص بك' : 'Advanced — use your own API key'}
          </button>
          {advancedOpen && (
            <div className="advanced-content">
              <p className="adv-note">
                {locale === 'ar'
                  ? 'يُرسَل مفتاحك مع كل طلب ولا يُخزَّن أبداً على خوادمنا. استخدام مفتاحك الخاص يتجاوز الحد اليومي المجاني ويتيح لك اختيار مزوّد الذكاء الاصطناعي.'
                  : 'Your key is sent per-request and never stored on our servers. Using your own key bypasses the daily free-page limit and lets you choose your AI provider.'}
              </p>
              <div className="adv-providers">
                <div className="provider-row">
                  <label className="provider-label">
                    <input
                      type="radio"
                      name="byok-provider"
                      value="gemini"
                      checked={byokProvider === 'gemini'}
                      onChange={() => handleProviderChange('gemini')}
                      disabled={running}
                    />
                    <div>
                      <div className="prov-name">{t('useGeminiFree', locale)}</div>
                      <div className="prov-note">
                        {locale === 'ar' ? 'لا حاجة لبطاقة ائتمان. احصل على مفتاح في 30 ثانية.' : 'No credit card required. Get a key in 30 seconds.'}
                      </div>
                    </div>
                  </label>
                  {byokProvider === 'gemini' && (
                    <div className="key-expand">
                      <KeyField
                        placeholder={`${t('apiKeyPlaceholder', locale)} (AIza…)`}
                        value={byokKey}
                        status={keyStatus}
                        error={keyError}
                        running={running}
                        linkHref="https://aistudio.google.com/apikey"
                        linkLabel={`${t('getGeminiKey', locale)} →`}
                        onInput={handleKeyInput}
                        onConfirm={confirmKey}
                        onChangeKey={changeKey}
                        locale={locale}
                      />
                      <div className="warn-note">
                        {t('geminiPrivacyWarning', locale)}
                      </div>
                    </div>
                  )}
                </div>
                <div className="provider-row">
                  <label className="provider-label">
                    <input
                      type="radio"
                      name="byok-provider"
                      value="anthropic"
                      checked={byokProvider === 'anthropic'}
                      onChange={() => handleProviderChange('anthropic')}
                      disabled={running}
                    />
                    <div>
                      <div className="prov-name">{t('useAnthropicKey', locale)}</div>
                      <div className="prov-note">
                        {locale === 'ar' ? 'الأفضل للمستندات الطبية والقانونية والبحثية.' : 'Best for medical, legal, and research documents.'}
                      </div>
                    </div>
                  </label>
                  {byokProvider === 'anthropic' && (
                    <div className="key-expand">
                      <KeyField
                        placeholder={`${t('apiKeyPlaceholder', locale)} (sk-ant-…)`}
                        value={byokKey}
                        status={keyStatus}
                        error={keyError}
                        running={running}
                        linkHref="https://console.anthropic.com/settings/keys"
                        linkLabel={locale === 'ar' ? 'احصل على مفتاح ←' : 'Get a key →'}
                        onInput={handleKeyInput}
                        onConfirm={confirmKey}
                        onChangeKey={changeKey}
                        locale={locale}
                      />
                    </div>
                  )}
                </div>
              </div>
              {usingByok && (
                <div className="adv-active-note">
                  {locale === 'ar'
                    ? `يُستخدم مفتاح ${byokProvider === 'gemini' ? 'Gemini' : 'Anthropic'} الخاص بك · تم تجاوز الحد اليومي.`
                    : `Using your ${byokProvider === 'gemini' ? 'Gemini' : 'Anthropic'} key · daily limit bypassed.`}
                </div>
              )}
            </div>
          )}
        </div>

        {/* ── Privacy note ── */}
        <p className="privacy-note">
          <b>{locale === 'ar' ? 'الخصوصية:' : 'Privacy:'}</b> {t('privacyNote', locale)}
          {' '}
          {usingByok && byokProvider === 'gemini' ? (
            <>{t('geminiPrivacyWarning', locale)}</>
          ) : (
            <>{t('defaultProviderNote', locale)}</>
          )}
        </p>

        {/* ── Progress ── */}
        <div className={`progress-wrap${pages.length > 0 ? ' show' : ''}`}>
          <div className="pbar">
            <div className="pfill" style={{ width: `${progressPct}%` }} />
          </div>
          <div className="pmeta">
            <span>{progressText}</span>
            <span className="dots">
              {pages.map(p => (
                <span key={p.num} className={`chip ${p.status}`} />
              ))}
            </span>
          </div>
        </div>

        {/* ── Disclaimer banner ── */}
        {pages.length > 0 && !disclaimerDismissed && (
          <div className="disclaimer-banner">
            <span>{DISCLAIMER[locale]}</span>
            <button
              type="button"
              className="disclaimer-close"
              onClick={() => setDisclaimerDismissed(true)}
              aria-label={t('dismiss', locale)}
            >
              ×
            </button>
          </div>
        )}

        {/* ── Results bar ── */}
        <div className={`results-bar${pages.length > 0 ? ' show' : ''}`}>
          <span className="title">
            {label?.fileName}
            {label && (
              <span className="muted"> · {t('pageLabel', locale)} {label.from}–{label.to}</span>
            )}
          </span>
          <div className="spacer" />
          <button
            className={`btn ghost${showEnglish ? ' on' : ''}`}
            onClick={() => setShowEnglish(v => !v)}
          >
            {showEnglish ? t('hideEnglishTerms', locale) : t('showEnglishTerms', locale)}
          </button>
          <button
            className={`btn ghost${showOriginal ? ' on' : ''}`}
            onClick={() => setShowOriginal(v => !v)}
          >
            {showOriginal ? t('hideOriginal', locale) : t('showOriginal', locale)}
          </button>
          <button className="btn ghost" onClick={() => window.print()}>
            {t('exportPdf', locale)}
          </button>
          <div className="export-menu" ref={exportRef}>
            <button
              className="btn ghost"
              disabled={allBlocks.length === 0}
              onClick={() => setExportOpen(v => !v)}
            >
              {t('exportLabel', locale)}
            </button>
            {exportOpen && (
              <div className="export-dropdown">
                <button className="export-item" onClick={exportWord}>{t('exportWord', locale)}</button>
                <button className="export-item" onClick={exportHtmlFile}>{t('exportHtml', locale)}</button>
                <button className="export-item" onClick={exportPdf}>{t('exportPdf', locale)}</button>
              </div>
            )}
          </div>
        </div>

        {/* ── Page cards ── */}
        <div id="results" className={`results${showOriginal ? ' with-original' : ''}`}>
          {pages.map((p, idx) => (
            <article
              key={p.num}
              className="page-card"
              style={{ animationDelay: `${idx * 0.04}s` }}
            >
              <div className="page-tag">صفحة {p.num} · Page {p.num}</div>
              {p.numberWarning && p.numberWarning.length > 0 && (
                <div className="number-warning">
                  {t('numberWarning', locale)}: {p.numberWarning.join(', ')}
                </div>
              )}
              <div className="card-grid">
                <div className="card-trans">
                  <div className="col-label">الترجمة · Arabic</div>
                  <div className="doc">
                    {p.status === 'pending' && <div className="skeleton" />}
                    {p.status === 'done' && p.blocks != null && (
                      <BlocksView blocks={p.blocks} showEnglish={showEnglish} locale={locale} />
                    )}
                    {p.status === 'failed' && (
                      <div className="page-failed">
                        <div className="ftitle">
                          {locale === 'ar' ? `تعذّرت ترجمة الصفحة ${p.num}` : `Couldn't translate page ${p.num}`}
                        </div>
                        <div className="fmsg">{p.error ?? (locale === 'ar' ? 'خطأ غير معروف' : 'Unknown error')}</div>
                        <button
                          className="btn ghost"
                          onClick={() => retryPage(p.num)}
                        >
                          {t('retry', locale)}
                        </button>
                      </div>
                    )}
                  </div>
                </div>
                <div className="card-orig">
                  <div className="col-label">الأصل · Original</div>
                  {p.image && (
                    <img src={p.image} alt={`Page ${p.num} original`} />
                  )}
                </div>
              </div>
            </article>
          ))}
        </div>

        {/* ── Footer ── */}
        <footer className="site-footer">
          <Link href="/privacy">{t('privacy', locale)}</Link>
          <span className="footer-sep">·</span>
          <Link href="/terms">{t('terms', locale)}</Link>
        </footer>

      </div>

      {aboutOpen && (
        <div className="about-overlay" onClick={() => setAboutOpen(false)}>
          <div className="about-panel" onClick={e => e.stopPropagation()}>
            <button type="button" className="about-close" onClick={() => setAboutOpen(false)} aria-label={t('dismiss', locale)}>×</button>
            <h2>{locale === 'ar' ? 'عن مُعرِّب' : 'About Muʿarrib'}</h2>
            {locale === 'ar' ? (
              <p>
                تُعرَض كل صفحة كصورة ويقرؤها نموذج رؤية — فلا يدخل أي ترميز نص PDF تالف خط الأنابيب.
                النتيجة عرض قراءة عربي مُعاد تنسيقه: جداول مُعاد بناؤها بالعربية، وأشكال تُوصَف مع
                إظهار الرسم الأصلي عبر «إظهار الأصل»، وأي شيء غير واضح أو غير مؤكد يُعلَّم بـ{' '}
                <span style={{ color: 'var(--amber)' }}>غير مؤكد</span> لتتحقق منه في المصدر.
              </p>
            ) : (
              <p>
                Each page is rendered to an image and read by a vision model — so corrupted PDF text
                encoding never enters the pipeline. Output is a clean reflowed reading view: tables
                rebuilt in Arabic, figures described with the original graphic shown under
                &quot;Show original&quot;, and anything blurry or uncertain marked{' '}
                <span style={{ color: 'var(--amber)' }}>غير مؤكد</span> so you can check it against the source.
              </p>
            )}
            <p>
              <b>{locale === 'ar' ? 'الخصوصية:' : 'Privacy:'}</b> {t('privacyNote', locale)}
            </p>
            <p className="about-legal-links">
              <Link href="/privacy">{t('privacy', locale)}</Link> · <Link href="/terms">{t('terms', locale)}</Link>
            </p>
          </div>
        </div>
      )}
    </>
  );
}
