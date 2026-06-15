/**
 * Standalone HTML export — the "share / view anywhere" format.
 *
 * Produces a single self-contained .html file (inline CSS, RTL) that opens with
 * correct Arabic in any browser — the browser shapes the script for free. Every
 * piece of model text is escaped (untrusted output), reusing the same escapeHtml
 * as the live app.
 */
import type { Block, TableCell } from './types';
import { escapeHtml } from './sanitize';

export interface HtmlOptions {
  title?: string;
  showEnglishTerms?: boolean;
}

function term(ar: string, en: string | undefined, show: boolean): string {
  const base = escapeHtml(ar);
  return show && en ? `${base} <bdi class="en">(${escapeHtml(en)})</bdi>` : base;
}

function blockToHtml(block: Block, show: boolean): string {
  const lc = block.lowconf === true;
  const wrap = (html: string) =>
    lc ? `<div class="lowconf"><span class="lc">⚠ غير مؤكد — راجع الأصل</span>${html}</div>` : html;

  switch (block.type) {
    case 'heading':
      return wrap(`<h2>${term(block.ar ?? '', block.en, show)}</h2>`);
    case 'subheading':
      return wrap(`<h3>${term(block.ar ?? '', block.en, show)}</h3>`);
    case 'paragraph':
      return wrap(`<p>${escapeHtml(block.ar ?? '')}</p>`);
    case 'list':
      return wrap(`<ul>${(block.items ?? []).map((i) => `<li>${escapeHtml(i)}</li>`).join('')}</ul>`);
    case 'caption':
      return wrap(`<p class="caption">${escapeHtml(block.ar ?? '')}</p>`);
    case 'figure':
      return wrap(`<div class="figure"><strong>شكل:</strong> ${escapeHtml(block.ar ?? '')}</div>`);
    case 'equation':
      return `<pre class="eq" dir="ltr">${escapeHtml(block.content ?? '')}</pre>`;
    case 'code':
      return `<pre class="code" dir="ltr">${escapeHtml(block.content ?? '')}</pre>`;
    case 'table': {
      const rows = block.rows ?? [];
      const cellHtml = (c: TableCell, header: boolean) => {
        const n = typeof c === 'string' ? { ar: c } : c;
        const inner = term(n.ar ?? '', n.en, show);
        return header ? `<th>${inner}</th>` : `<td>${inner}</td>`;
      };
      const body = rows
        .map((row, ri) => `<tr>${row.map((c) => cellHtml(c, ri === 0)).join('')}</tr>`)
        .join('');
      return wrap(`<table dir="rtl">${body}</table>`);
    }
    default:
      return '';
  }
}

export function buildTranslationHtml(blocks: Block[], options: HtmlOptions = {}): string {
  const show = options.showEnglishTerms ?? false;
  const title = escapeHtml(options.title ?? 'ترجمة Muʿarrib');
  const body = blocks.map((b) => blockToHtml(b, show)).join('\n');

  return `<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title}</title>
<style>
  :root{ --ink:#211c15; --soft:#5b5346; --faint:#8a8070; --accent:#0e5c52; --rule:#dccfb6; --paper:#f5efe3; --amber:#9c5a14; }
  *{box-sizing:border-box}
  body{ margin:0; background:var(--paper); color:var(--ink);
    font-family:'Amiri','Sakkal Majalla','Noto Naskh Arabic','Geeza Pro',Tahoma,serif;
    direction:rtl; text-align:right; line-height:1.95; }
  .wrap{ max-width:74ch; margin:0 auto; padding:48px 24px 80px; }
  .brand{ text-align:center; color:var(--accent); font-size:34px; font-weight:700; margin:0 0 4px; }
  .sub{ text-align:center; color:var(--soft); font-size:15px; margin:0 0 6px; }
  .disclaimer{ text-align:center; color:var(--faint); font-size:12.5px; font-style:italic;
    margin:0 0 28px; padding-bottom:20px; border-bottom:1px solid var(--rule); }
  h2{ color:#0a423b; font-size:26px; margin:26px 0 12px; }
  h3{ font-size:21px; margin:20px 0 10px; }
  h2 .en, h3 .en{ font-family:system-ui,sans-serif; font-size:13px; color:var(--faint); direction:ltr; }
  p{ margin:0 0 15px; } .caption{ color:var(--soft); font-style:italic; font-size:15px;
    border-inline-start:2px solid var(--rule); padding-inline-start:12px; }
  ul{ padding-inline-end:24px; padding-inline-start:0; } li{ margin-bottom:7px; }
  .figure{ background:#fbf3e6; border:1px solid var(--rule); border-radius:10px; padding:14px 16px; margin:8px 0 18px; }
  .figure strong{ color:var(--amber); }
  table{ border-collapse:collapse; width:100%; direction:rtl; margin:8px 0 20px; border:1px solid var(--rule); font-size:16px; }
  th,td{ border:1px solid #e7ddc8; padding:9px 13px; text-align:right; vertical-align:top; }
  th{ background:#0e5c520f; color:#0a423b; font-weight:700; }
  tr:nth-child(even) td{ background:#f8f2e6; }
  .en{ font-family:system-ui,sans-serif; font-size:.74em; color:var(--faint); direction:ltr; unicode-bidi:isolate; }
  pre.eq,pre.code{ direction:ltr; text-align:left; font-family:'JetBrains Mono',ui-monospace,Menlo,Consolas,monospace;
    background:#f3ecdd; border:1px solid var(--rule); border-radius:9px; padding:13px 15px; margin:8px 0 18px; overflow-x:auto; white-space:pre-wrap; }
  pre.eq{ text-align:center; }
  .lowconf{ border-inline-start:3px solid var(--amber); background:#9c5a1410; padding:4px 14px; border-radius:0 8px 8px 0; margin-bottom:14px; }
  .lowconf .lc{ display:block; color:var(--amber); font-size:11.5px; font-weight:600; margin:6px 0 2px; }
  footer{ margin-top:50px; padding-top:18px; border-top:1px solid var(--rule); text-align:center;
    color:var(--faint); font-size:12px; font-family:system-ui,sans-serif; }
</style>
</head>
<body>
  <div class="wrap">
    <div class="brand">مُعرِّب</div>
    <div class="sub">${title}</div>
    <div class="disclaimer">ترجمة آلية — يُرجى مراجعة الأرقام والمصطلحات المهمة مقابل النص الأصلي.</div>
    ${body}
    <footer>تُرجم بواسطة مُعرِّب · Muʿarrib</footer>
  </div>
</body>
</html>`;
}
