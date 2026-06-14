# Muʿarrib — Build Brief for Claude Code (v3)

> This file lives in the repo root as `CLAUDE.md` so the agent keeps the plan in context across the whole build. **This v3 replaces v2** — it reflects the shipped default-mode/BYOK split, the Arabic-only default output, and the truncation-only split strategy.

---

## 0. What you are building (context for the agent)

Muʿarrib is a web app that translates **English PDFs into native, correctly-rendered Arabic**. The core thesis: every other tool extracts the PDF's text and corrupts Arabic shaping/direction on output. Muʿarrib instead **renders each page to an image and has a vision model read the image** — so corruption never enters the pipeline. Output is a **reflowed Arabic reading view**, not a pixel-perfect copy of the layout.

`muarrib.html` (in this repo) is the original single-file proof; its frontend logic, vision prompt (`lib/prompt.ts`), and styling were ported into the Next.js app under `app/`.

---

## 1. Architecture

- **Next.js (App Router) + TypeScript**, deployed on **Vercel**.
  - **Frontend:** `app/muarrib-app.tsx`, a single client component.
  - **Backend:** `POST /api/translate-page` (`app/api/translate-page/route.ts`) — accepts a page image + page number + provider, calls that provider, returns validated JSON blocks. `POST /api/verify-key` (`app/api/verify-key/route.ts`) does a 1-token ping to confirm a BYOK key authenticates before translation is unblocked.
  - **PDF rendering stays 100% client-side** (pdf.js via CDN, loaded with `next/script`). The full PDF is **never uploaded** — only individual page images go to the proxy.
- `export const maxDuration = 60` is set on `/api/translate-page` (Hobby plan cap). If Fluid Compute / a paid plan is enabled, raise this — dense pages that split into two half-page calls plus a possible Gemini 429 retry can approach it.

---

## 2. Default mode vs. Advanced (BYOK)

- **Default (no key needed):** every request is served with the **owner's Anthropic key** from `ANTHROPIC_API_KEY` (env var), using `ANTHROPIC_MODEL` (`lib/config.ts`, currently `claude-haiku-4-5-20251001`). This is gated by a **per-IP daily page cap** (`lib/ratelimit.ts`, `DAILY_PAGE_CAP`, default 30, overridable via env var). The cap is in-memory per warm serverless instance — fine for early testing, swap for Upstash/Redis before wider launch.
- **Advanced (BYOK):** collapsed by default. The user picks **Gemini** (free tier, just a Google account, link to `https://aistudio.google.com/apikey`) or **Anthropic** (higher quality, not used for training — recommended for confidential/medical/research docs). The key is verified via `/api/verify-key` (Confirm button → locks once valid) before the Translate button unblocks. Verified keys are sent per-request via `x-user-api-key` header and **never stored server-side**; the proxy uses that header when present, falling back to the server env var otherwise.
- The Gemini free-tier privacy warning ("may be used to improve Google's models — not for confidential/patient documents") is shown inline under the Gemini key field, and the page-level privacy note adjusts depending on which mode/provider is active.

### Model config (`lib/config.ts`)
```ts
export const ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001';
export const GEMINI_MODEL = 'gemini-2.5-flash';
export const MAX_TOKENS = 4096;
```
Verify current names/pricing before changing:
- Anthropic models: https://docs.claude.com/en/docs/about-claude/models
- Gemini models: https://ai.google.dev/gemini-api/docs/models

---

## 3. The translation route (`/api/translate-page`)

- **Input:** `{ imageBase64, pageNum, provider }` (`provider` is `"anthropic"` or `"gemini"`), plus optional `x-user-api-key` header.
- **Provider adapters** (`lib/providers/anthropic.ts`, `lib/providers/gemini.ts`): each takes `(imageBase64, pageNum, apiKey)`, calls the provider's vision API with `buildPrompt()` from `lib/prompt.ts`, and returns `{ text, truncated }` where `truncated` reflects `stop_reason === 'max_tokens'` / `finishReason === MAX_TOKENS`.
- **Output parsing:** `stripToJsonArray` strips code fences, parses directly, and falls back to slicing from the first `[` to the last `]` on failure. `validateBlocks` filters to known block types (heading, subheading, paragraph, list, table, caption, figure, equation, code; optional `lowconf`).
- **One call per page by default.** The route does **not** pre-split pages. It returns `{ blocks, truncated, parseFailed }` — splitting only happens client-side, and only in response to `truncated` or `parseFailed` (see §4).
- **Gemini 429 handling:** `callGemini` retries once after the server-suggested delay (capped at 30s) on a 429.
- **Never log file contents or the user's key.** Errors are mapped to friendly messages (`friendlyError`) without leaking key material.

---

## 4. Frontend translation flow (`app/muarrib-app.tsx`)

- **Concurrency:** server-key/Anthropic mode runs `CONCURRENCY = 3` pages in parallel. A verified **Gemini BYOK** key drops to `GEMINI_CONCURRENCY = 1` with `GEMINI_SPACING_MS = 13_000` between calls, to stay under the free tier's 5 requests/minute.
- **Splitting is reactive, not proactive.** `processOnePage` makes **one normal call** per page. Only if that call comes back `truncated` or `parseFailed` does it call `splitImageVertically`, send the top and bottom halves as two separate calls, and merge the returned block arrays in order. Per-page "Retry" runs the same logic.
- **Output language:** blocks render in **Arabic by default**. A "Show English terms" toggle (`showEnglish`, default off, persisted in `sessionStorage` for the session) reveals the `en`/term fields inline (table cells, headings, etc.) without changing the underlying data.
- Other ported behavior kept as-is: drag-drop upload, page-range selector + AI-call estimate, live progress bar with per-page status chips, RTL reading view with rebuilt tables, LTR-preserved equations/code, figure descriptions with "Show original" toggle, low-confidence (`غير مؤكد`) flags, and Print/Save-PDF.

---

## 5. Robustness / known fragile points

- **pdf.js loading:** `next/script` loads pdf.js from a CDN (`PDF_SRC`/`PDF_WORKER`, version-pinned and must match). The `onLoad` handler guards against `window.pdfjsLib` being undefined (cached-script ordering), and `loadFile` re-sets `workerSrc` defensively if missing. All pdf.js/canvas/`window`/`sessionStorage` access happens inside `useEffect`/event handlers in a `'use client'` component — nothing runs at module scope during SSR.
- **`app/error.tsx`** is a client error boundary: on an uncaught client exception it shows a recovery screen ("Try again" / "Reload") and reassures the user their PDF was never uploaded.

---

## 6. Privacy stance (state plainly on the page)

"Your PDF never leaves your browser as a file. Only individual page **images** are sent to the AI, only to be translated. Nothing is stored or logged on our servers." When a BYOK Gemini key is active, the note adds that the **free tier may use images to improve Google's models** — not for confidential/patient documents; the default (Anthropic) tier is not used for training.

---

## 7. Out of scope for v1 — do NOT build yet

Accounts/login, billing UI, usage dashboards, translation history, multiple target languages, scanned-PDF OCR tuning, mobile app, teams/sharing, Redis-backed rate limiting. Add only after real users ask.

---

## 8. Later (Phase 5+)

Number cross-check (diff text-layer numbers vs vision output, auto-flag mismatches — the trust layer for medicine); `.docx`/PDF export; optional freemium + Stripe; persistent (Redis) rate limiting if the in-memory per-instance cap proves insufficient.
