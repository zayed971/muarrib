'use client';

import { useRef, useState, useCallback, useEffect } from 'react';
import Script from 'next/script';
import type { Block } from '@/lib/types';

// ─── pdf.js minimal types (CDN global)
interface PdfViewport { width: number; height: number; }
interface PdfPage {
  getViewport(o: { scale: number }): PdfViewport;
  render(o: { canvasContext: CanvasRenderingContext2D; viewport: PdfViewport }): { promise: Promise<void> };
}
interface PdfDocument { numPages: number; getPage(n: number): Promise<PdfPage>; }
declare global {
  interface Window {
    pdfjsLib: {
      GlobalWorkerOptions: { workerSrc: string };
      getDocument(o: { data: ArrayBuffer }): { promise: Promise<PdfDocument> };
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
): Promise<{ blocks: Block[]; truncated: boolean; parseFailed: boolean }> {
  const imageBase64 = dataUrl.split(',')[1];
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers['x-user-api-key'] = apiKey;
  const res = await fetch('/api/translate-page', {
    method: 'POST',
    headers,
    body: JSON.stringify({ imageBase64, pageNum, provider }),
  });
  const data: { blocks?: Block[]; error?: string; truncated?: boolean; parseFailed?: boolean; rateLimited?: boolean } =
    await res.json();
  if (data.rateLimited) {
    const e = new Error(data.error ?? 'Daily page limit reached');
    (e as Error & { rateLimited: boolean }).rateLimited = true;
    throw e;
  }
  if (!res.ok || data.error) throw new Error(data.error ?? `HTTP ${res.status}`);
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
  imageCache: Map<number, string>,
  onUpdate: (num: number, patch: Partial<PageState>) => void,
  onRateLimit?: () => void,
): Promise<void> {
  try {
    let image = imageCache.get(num) ?? null;
    if (!image) {
      image = await renderPageImage(doc, num);
      imageCache.set(num, image);
      onUpdate(num, { image });
    }

    const { blocks, truncated, parseFailed } = await callProxy(image, num, provider, apiKey);

    if (truncated || parseFailed) {
      // Hit the token limit or returned unparseable JSON — split into top/bottom
      // halves, translate each separately, and merge in reading order
      const [topUrl, botUrl] = await splitImageVertically(image);
      const [topResult, botResult] = await Promise.all([
        callProxy(topUrl, num, provider, apiKey),
        callProxy(botUrl, num, provider, apiKey),
      ]);
      onUpdate(num, {
        status: 'done',
        blocks: [...topResult.blocks, ...botResult.blocks],
        error: null,
      });
    } else {
      onUpdate(num, { status: 'done', blocks, error: null });
    }
  } catch (err) {
    if ((err as { rateLimited?: boolean }).rateLimited) onRateLimit?.();
    onUpdate(num, {
      status: 'failed',
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ─── Block rendering
type TableCell = { ar: string; en?: string } | string;

function CellContent({ cell, showEnglish }: { cell: TableCell; showEnglish: boolean }) {
  const c = typeof cell === 'object' && cell !== null ? cell : { ar: String(cell ?? '') };
  return (
    <>
      {c.ar}
      {showEnglish && c.en && <bdi className="term-en">({c.en})</bdi>}
    </>
  );
}

function BlockItem({ block, showEnglish }: { block: Block; showEnglish: boolean }) {
  let inner: React.ReactNode;

  switch (block.type) {
    case 'heading':
      inner = (
        <h3 className="b-h">
          {block.ar}
          {showEnglish && block.en && <span className="en">{block.en}</span>}
        </h3>
      );
      break;
    case 'subheading':
      inner = (
        <h4 className="b-sh">
          {block.ar}
          {showEnglish && block.en && <span className="en">{block.en}</span>}
        </h4>
      );
      break;
    case 'paragraph':
      inner = <p className="b-p">{block.ar}</p>;
      break;
    case 'list':
      inner = (
        <ul className="b-list">
          {(block.items ?? []).map((it, i) => <li key={i}>{it}</li>)}
        </ul>
      );
      break;
    case 'caption':
      inner = <p className="b-cap">{block.ar}</p>;
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
          <div className="fdesc">{block.ar}</div>
          <div className="hint">اضغط «Show original» لرؤية الشكل الأصلي.</div>
        </div>
      );
      break;
    case 'equation':
      inner = <div className="b-eq" dir="ltr">{block.content ?? block.ar}</div>;
      break;
    case 'code':
      inner = <pre className="b-code" dir="ltr">{block.content ?? block.ar}</pre>;
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
                    <th key={ci}><CellContent cell={cell as TableCell} showEnglish={showEnglish} /></th>
                  ))}
                </tr>
              </thead>
            )}
            <tbody>
              {rows.slice(1).map((row, ri) => (
                <tr key={ri}>
                  {(row ?? []).map((cell, ci) => (
                    <td key={ci}><CellContent cell={cell as TableCell} showEnglish={showEnglish} /></td>
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
      inner = block.ar ? <p className="b-p">{block.ar}</p> : null;
  }

  if (!inner) return null;

  if (block.lowconf) {
    return (
      <div className="lowconf">
        <span className="lc-tag">غير مؤكد — راجع الأصل · uncertain, check source</span>
        {inner}
      </div>
    );
  }
  return <>{inner}</>;
}

function BlocksView({ blocks, showEnglish }: { blocks: Block[]; showEnglish: boolean }) {
  if (!blocks.length) {
    return (
      <p className="b-cap">
        لا يوجد نص قابل للترجمة في هذه الصفحة (غلاف، صفحة فارغة، أو صورة فقط).
      </p>
    );
  }
  return (
    <>
      {blocks.map((b, i) => <BlockItem key={i} block={b} showEnglish={showEnglish} />)}
    </>
  );
}

// ─── Key field: input + Confirm/locked states for BYOK verification
function KeyField({
  placeholder, value, status, error, running, linkHref, linkLabel, onInput, onConfirm, onChangeKey,
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
            <span className="key-active">✓ Key active</span>
            <button type="button" className="link-btn" onClick={onChangeKey} disabled={running}>
              Change
            </button>
          </>
        ) : (
          <button
            type="button"
            className="btn ghost confirm-btn"
            onClick={onConfirm}
            disabled={running || !value.trim() || verifying}
          >
            {verifying ? 'Checking…' : 'Confirm'}
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

  // Advanced / BYOK state (collapsed by default — default mode needs no key)
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [byokProvider, setByokProvider] = useState<Provider>('gemini');
  const [byokKey, setByokKey] = useState('');
  const [keyStatus, setKeyStatus] = useState<KeyStatus>('unverified');
  const [keyError, setKeyError] = useState('');
  const [rateLimitHit, setRateLimitHit] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const imageCache = useRef<Map<number, string>>(new Map());

  // ─── Remember the "show English terms" choice for this browser session
  useEffect(() => {
    if (sessionStorage.getItem('muarrib-show-english') === 'true') setShowEnglish(true);
  }, []);
  useEffect(() => {
    sessionStorage.setItem('muarrib-show-english', String(showEnglish));
  }, [showEnglish]);

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
    const prov: Provider = usByok ? byokProvider : 'anthropic';
    const key = usByok ? byokKey.trim() : '';
    setRateLimitHit(false);
    const { from, to, count } = clamp();
    const nums = Array.from({ length: count }, (_, i) => from + i);

    imageCache.current = new Map();
    setPages(nums.map(n => ({ num: n, status: 'pending', image: null, blocks: null, error: null })));
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
      processOnePage(num, doc, prov, key, cache, updatePage, () => setRateLimitHit(true)),
      spacing,
    );
    setRunning(false);
  }, [running, pdfDoc, byokKey, byokProvider, keyStatus, fileName, clamp, updatePage]);

  const retryPage = useCallback(async (num: number) => {
    if (!pdfDoc) return;
    const keyEntered = byokKey.trim().length > 0;
    if (keyEntered && keyStatus !== 'verified') return;
    const usByok = keyStatus === 'verified';
    const prov: Provider = usByok ? byokProvider : 'anthropic';
    const key = usByok ? byokKey.trim() : '';
    updatePage(num, { status: 'pending', error: null });
    await processOnePage(num, pdfDoc, prov, key, imageCache.current, updatePage, () => setRateLimitHit(true));
  }, [pdfDoc, byokKey, byokProvider, keyStatus, updatePage]);

  // ─── Derived
  const usingByok = keyStatus === 'verified';
  const keyEntered = byokKey.trim().length > 0;
  const blockedByUnverifiedKey = keyEntered && keyStatus !== 'verified';
  const range = clamp();
  const finished = pages.filter(p => p.status === 'done' || p.status === 'failed').length;
  const failed = pages.filter(p => p.status === 'failed').length;
  const progressPct = pages.length ? (finished / pages.length) * 100 : 0;
  const progressText = pages.length === 0
    ? ''
    : finished < pages.length
    ? `Reading page ${finished} of ${pages.length}…`
    : `Done — ${pages.length - failed} of ${pages.length} page${pages.length === 1 ? '' : 's'} translated${failed ? ` · ${failed} failed (retry below)` : ''}.`;

  // ─── Render
  return (
    <>
      <Script
        src={PDF_SRC}
        strategy="afterInteractive"
        onLoad={() => {
          window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDF_WORKER;
        }}
      />

      <div className="wrap">
        {/* ── Header ── */}
        <header>
          <div className="brand">
            <span className="mark">مُعرِّب</span>
            <h1><span className="latin-name">Muʿarrib</span></h1>
            <button type="button" className="about-link" onClick={() => setAboutOpen(true)}>
              <span aria-hidden="true">ⓘ</span> About
            </button>
          </div>
          <p className="tagline">
            English PDFs, read in real Arabic — letters connected, direction correct, tables rebuilt.
            The kind a vision model reads the way a person does.
          </p>
          <div className="how">
            {[
              'Upload an English PDF',
              'Choose pages',
              'Translate — the AI reads each page as an image',
              'Read, compare to the original, or save',
            ].map((s, i) => (
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
          <div className="big">Drop an English PDF here</div>
          <div className="sub">or click to choose — stays in your browser until you translate</div>
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
            <button className="btn ghost" onClick={reset} disabled={running}>New file</button>
          </div>
          <div className="ctrl-body">
            <div className="field">
              <label>Pages to translate</label>
              <div className="range-inputs">
                <span>from</span>
                <input
                  type="number"
                  value={fromPage}
                  min={1}
                  max={numPages}
                  onChange={e => setFromPage(parseInt(e.target.value, 10) || 1)}
                  onBlur={() => { const r = clamp(); setFromPage(r.from); setToPage(r.to); }}
                  disabled={running}
                />
                <span>to</span>
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
              <b>{range.count}</b> page{range.count === 1 ? '' : 's'} → <b>{range.count}</b> AI call{range.count === 1 ? '' : 's'}.
              {range.count > WARN_ABOVE && (
                <span className="warn"> Large jobs are slower &amp; cost more — try a chapter first.</span>
              )}
            </div>
            <div className="spacer" />
            <button
              className="btn primary"
              onClick={run}
              disabled={running || !pdfDoc || blockedByUnverifiedKey}
            >
              {running ? 'Translating…' : 'Translate to Arabic'}
            </button>
            {blockedByUnverifiedKey && (
              <div className="key-block-hint">
                {keyStatus === 'verifying'
                  ? 'Verifying your key…'
                  : 'Confirm your API key in Advanced settings below to translate with it — or clear it to use the free default.'}
              </div>
            )}
          </div>
        </div>

        {/* ── Rate-limit banner ── */}
        {rateLimitHit && !usingByok && (
          <div className="rate-limit-banner">
            <b>Free daily limit reached.</b> You&apos;ve hit today&apos;s free-page limit on the shared key.{' '}
            <button
              className="link-btn"
              onClick={() => { setAdvancedOpen(true); }}
            >
              Add your own API key
            </button>{' '}
            in Advanced Settings below to keep going, or come back tomorrow.
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
            Advanced — use your own API key
          </button>
          {advancedOpen && (
            <div className="advanced-content">
              <p className="adv-note">
                Your key is sent per-request and never stored on our servers.
                Using your own key bypasses the daily free-page limit and lets you choose your AI provider.
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
                      <div className="prov-name">Gemini — free, just a Google account</div>
                      <div className="prov-note">No credit card required. Get a key in 30 seconds.</div>
                    </div>
                  </label>
                  {byokProvider === 'gemini' && (
                    <div className="key-expand">
                      <KeyField
                        placeholder="Paste your Gemini API key (AIza…)"
                        value={byokKey}
                        status={keyStatus}
                        error={keyError}
                        running={running}
                        linkHref="https://aistudio.google.com/apikey"
                        linkLabel="Get a free key →"
                        onInput={handleKeyInput}
                        onConfirm={confirmKey}
                        onChangeKey={changeKey}
                      />
                      <div className="warn-note">
                        The free Gemini tier may use your prompts to improve Google&apos;s models.
                        <strong> Not for confidential or patient documents.</strong>
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
                      <div className="prov-name">Anthropic — Claude, not used for training</div>
                      <div className="prov-note">Best for medical, legal, and research documents.</div>
                    </div>
                  </label>
                  {byokProvider === 'anthropic' && (
                    <div className="key-expand">
                      <KeyField
                        placeholder="Paste your Anthropic API key (sk-ant-…)"
                        value={byokKey}
                        status={keyStatus}
                        error={keyError}
                        running={running}
                        linkHref="https://console.anthropic.com/settings/keys"
                        linkLabel="Get a key →"
                        onInput={handleKeyInput}
                        onConfirm={confirmKey}
                        onChangeKey={changeKey}
                      />
                    </div>
                  )}
                </div>
              </div>
              {usingByok && (
                <div className="adv-active-note">
                  Using your {byokProvider === 'gemini' ? 'Gemini' : 'Anthropic'} key · daily limit bypassed.
                </div>
              )}
            </div>
          )}
        </div>

        {/* ── Privacy note ── */}
        <p className="privacy-note">
          <b>Privacy:</b> Your PDF never leaves your browser as a file. Only individual page <b>images</b> are
          sent to the AI, only to be translated. Nothing is stored or logged on our servers.
          {usingByok && byokProvider === 'gemini' ? (
            <> When using your Gemini key, the <b>free tier may use images to improve Google&apos;s models</b> — not for confidential documents.</>
          ) : (
            <> The default free tier uses Claude (Anthropic) — paid tiers are not used for model training, making it suitable for medical, legal, and research documents.</>
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

        {/* ── Results bar ── */}
        <div className={`results-bar${pages.length > 0 ? ' show' : ''}`}>
          <span className="title">
            {label?.fileName}
            {label && (
              <span className="muted"> · pages {label.from}–{label.to}</span>
            )}
          </span>
          <div className="spacer" />
          <button
            className={`btn ghost${showEnglish ? ' on' : ''}`}
            onClick={() => setShowEnglish(v => !v)}
          >
            {showEnglish ? 'Hide English terms' : 'Show English terms'}
          </button>
          <button
            className={`btn ghost${showOriginal ? ' on' : ''}`}
            onClick={() => setShowOriginal(v => !v)}
          >
            {showOriginal ? 'Hide original' : 'Show original'}
          </button>
          <button className="btn ghost" onClick={() => window.print()}>
            Save / Print PDF
          </button>
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
              <div className="card-grid">
                <div className="card-trans">
                  <div className="col-label">الترجمة · Arabic</div>
                  <div className="doc">
                    {p.status === 'pending' && <div className="skeleton" />}
                    {p.status === 'done' && p.blocks != null && (
                      <BlocksView blocks={p.blocks} showEnglish={showEnglish} />
                    )}
                    {p.status === 'failed' && (
                      <div className="page-failed">
                        <div className="ftitle">Couldn&apos;t translate page {p.num}</div>
                        <div className="fmsg">{p.error ?? 'Unknown error'}</div>
                        <button
                          className="btn ghost"
                          onClick={() => retryPage(p.num)}
                        >
                          Retry this page
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

      </div>

      {aboutOpen && (
        <div className="about-overlay" onClick={() => setAboutOpen(false)}>
          <div className="about-panel" onClick={e => e.stopPropagation()}>
            <button type="button" className="about-close" onClick={() => setAboutOpen(false)} aria-label="Close">×</button>
            <h2>About Muʿarrib</h2>
            <p>
              Each page is rendered to an image and read by a vision model — so corrupted PDF text
              encoding never enters the pipeline. Output is a clean reflowed reading view: tables
              rebuilt in Arabic, figures described with the original graphic shown under
              &quot;Show original&quot;, and anything blurry or uncertain marked{' '}
              <span style={{ color: 'var(--amber)' }}>غير مؤكد</span> so you can check it against the source.
            </p>
            <p>
              <b>Privacy:</b> Your PDF never leaves your browser as a file — only individual page
              images are sent to the AI you choose, only to be translated, and nothing is stored or
              logged on our servers.
            </p>
          </div>
        </div>
      )}
    </>
  );
}
