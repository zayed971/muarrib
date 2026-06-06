# Muʿarrib — Build Brief for Claude Code

> Drop this file in the repo root as `CLAUDE.md` so the agent keeps the plan in context across the whole build. Feed it the phase prompts in §8 one at a time — never all at once.

---

## 0. What you are building (context for the agent)

Muʿarrib is a web app that translates **English PDFs into native, correctly-rendered Arabic**. The core thesis: every other tool extracts the PDF's text and corrupts Arabic shaping/direction on output. Muʿarrib instead **renders each page to an image and has a vision model read the image** — so corruption never enters the pipeline. Output is a **reflowed Arabic reading view**, not a pixel-perfect copy of the layout.

A working single-file proof already exists at `muarrib.html` (provided alongside this brief). It runs the full pipeline. **Reuse its frontend logic, its vision prompt, and its styling.** Your job is to turn that proof into a real, deployable, multi-user app.

---

## 1. The one non-negotiable change from the proof

The proof calls the Anthropic API **directly from the browser with no API key** — that only works inside the Claude.ai sandbox. A real app must **never** ship an API key in client code (anyone can extract it). Every model call goes through a **backend proxy** that holds the key server-side. This is the single most important architectural change. Everything else is reuse and polish.

---

## 2. Recommended stack (one path — don't deviate without a real reason)

- **Next.js (App Router) + TypeScript**, deployed on **Vercel**.
  - **Frontend:** a client component ported from `muarrib.html`.
  - **Backend:** one API route, `POST /api/translate-page`, that accepts a page image + page number, calls the model, returns parsed JSON blocks.
  - **PDF rendering stays 100% client-side** (pdf.js). The full PDF is **never uploaded** — only individual page images go to the proxy. This is both a privacy and a cost decision.
- **Why this stack:** one repo, one `vercel deploy`, scales serverlessly to thousands of users with zero server management. Claude Code handles Next.js + Vercel extremely well.
- **Acceptable alternative** (only if you already prefer it): Cloudflare Pages + a Worker for the proxy. Same shape, same rules.

For Claude Code install/Node requirements, see the official docs: https://docs.claude.com/en/docs/claude-code/overview

---

## 3. Cost model — A DECISION THE OWNER MUST MAKE

Every translated page = one paid vision API call. At thousands of users this is real recurring money. Two clean options:

- **(A) Bring-Your-Own-Key — recommended for v1.** The user pastes their own Anthropic API key. The proxy uses it per-request and **never stores it**. Owner pays $0. Fastest path to many users. **Ship this first.**
- **(B) Freemium.** Owner holds one key, gives each user a small free quota (e.g. 20 pages), then requires sign-in + payment (Stripe). More friction, real cost, more to build. **Add later, only once people actually use it.**

**Default for this build: (A).** Architect a clean seam so (B) can be added without a rewrite (i.e. the proxy reads the key from either the request header *or* a server env var).

### Model choice (also owner's call)
Per-page reading is cost-sensitive and does not need the largest model. Recommend **Claude Sonnet (current version) for quality**, or **Claude Haiku (current version) for lowest cost per page**. Do **not** default to Opus for per-page work at scale. Confirm current model strings and pricing before wiring: https://docs.claude.com/en/docs/about-claude/models and the pricing page. Make the model name a single config constant.

---

## 4. The translation route (`/api/translate-page`)

- **Input:** `{ imageBase64: string, pageNum: number }`, plus the user's API key via an `x-user-api-key` header (BYOK).
- **Action:** call the Messages API with the vision prompt **copied verbatim from `muarrib.html`** (it is already tuned for structure, number-exactness, bilingual terms, and never translating code/equations).
- **Fix the truncation limit from the proof.** The proof was capped at ~1000 output tokens by the sandbox. Here, set a real `max_tokens` (e.g. 4096). For very dense pages that still risk truncation, support splitting the page image into top/bottom halves, translating each, and merging the block arrays in order.
- **Validate the output.** Parse the JSON array; validate against a schema (block types: heading, subheading, paragraph, list, table, caption, figure, equation, code; plus optional `lowconf`). On malformed JSON, attempt repair (slice first `[` to last `]`), then one server-side retry, then return a structured error so the frontend can show a per-page "Retry".
- **Never log file contents or the user's key.**
- **Output:** the validated block array.

---

## 5. Frontend (port from `muarrib.html`)

**Keep all of this — it already works:** drag-drop upload, page-range selector + call estimate, the 3-at-a-time concurrency pool, live progress bar with per-page status, **per-page Retry**, the RTL Arabic reading view, **rebuilt RTL tables**, **preserved LTR equations & code**, **figure descriptions + Show-original toggle** (the real graphic is shown, never redrawn), **low-confidence flags** (`غير مؤكد`), and **Print / Save-PDF** (browser renderer keeps Arabic correct — this is the trick competitors fail at).

**Change:** call `/api/translate-page` instead of the Anthropic API directly.

**Add:** a "Your Anthropic API key" field (BYOK). Store it in session/memory only. Show a one-line, honest note: *"Your key is sent with each translation request to make the AI call and is never stored on our servers. Your PDF stays in your browser; only page images are sent to be translated."*

---

## 6. Privacy stance (this is a FEATURE for medical/research users, not boilerplate)

- The PDF is opened and rendered **in the browser**. Only individual page **images** are sent to the proxy, only to be translated. **Nothing is stored. No content is logged.** State this plainly on the page. For hospitals/researchers, this is the difference between "allowed to use" and "not."

---

## 7. Build phases — each MUST run and be verifiable before moving on

This staging is the whole point: every checkpoint is a thing you can open in a browser and show a real person.

- **Phase 1 — Skeleton that translates.** Scaffold Next.js + Vercel; port the frontend; for now read the key from a server env var (`ANTHROPIC_API_KEY`); get **one real PDF translating end-to-end through the proxy**; deploy.
  - ✅ Checkpoint: a live URL that correctly translates a page of a real English PDF.
- **Phase 2 — BYOK.** Replace the dev env key with the user-supplied-key flow; add the privacy note.
  - ✅ Checkpoint: a stranger can use the live URL with their own key.
- **Phase 3 — Robustness.** Truncation fix (bigger `max_tokens` + page-half splitting), schema validation, server retry.
  - ✅ Checkpoint: a dense two-column medical page translates without truncating or breaking.
- **Phase 4 — Ship-ready polish.** Error states, mobile layout, loading copy, the print stylesheet, and a short landing section explaining what the tool is and why it works.
  - ✅ Checkpoint: you'd send the link to 10 real students/researchers without apologizing for it.
- **Phase 5 — Later, only if people use it.** Number cross-check (diff the page's text-layer numbers against the vision output, auto-flag mismatches — the real trust layer for medicine); `.docx`/PDF export; optional freemium + Stripe.

---

## 8. Exact first prompts to give Claude Code (in order)

1. *"Create a Next.js (App Router) + TypeScript app called `muarrib`. Add one API route `POST /api/translate-page` that accepts `{ imageBase64, pageNum }` and an `x-user-api-key` header, calls the Anthropic Messages API (model from a single config constant; key from the header, falling back to `process.env.ANTHROPIC_API_KEY`) using this exact vision prompt: [paste the `buildPrompt` text from `muarrib.html`]. Parse the JSON array from the response, validate the block types, repair-then-retry once on malformed JSON, and return the validated array or a structured error."*
2. *"Build the frontend as a client component based on this file: [attach `muarrib.html`]. Keep the upload, page-range + estimate, 3-concurrent pool, progress bar, per-page retry, RTL reading view, table/equation/code/figure rendering, low-confidence flags, Show-original toggle, and Print. Change it to call `/api/translate-page` instead of the Anthropic API directly. Keep the styling and fonts."*
3. *"Add the Bring-Your-Own-Key field and privacy note from the brief: the user's key is sent per-request to `/api/translate-page` and never stored server-side."*
4. *"Add the truncation fix: raise `max_tokens`, and for dense pages split the page image into top/bottom halves, translate each, and merge the block arrays in reading order."*
5. *"Deploy to Vercel. Walk me through connecting the GitHub repo and setting the env var."*

---

## 9. Out of scope for v1 — do NOT build these yet

Accounts/login, billing UI, usage dashboards, translation history, multiple target languages, scanned-PDF OCR tuning, a mobile app, teams/sharing. Add any of these **only after real users ask for them.** Adding them now is how v1 never ships.

---

## 10. The decisions only the owner can make (do these before/at Phase 2)

1. **Cost model:** BYOK (recommended) or freemium.
2. **Model:** Sonnet (quality) vs Haiku (cost) — confirm current strings/pricing.
3. **Name + domain:** "Muʿarrib" works as a name; check that a matching domain is free.
