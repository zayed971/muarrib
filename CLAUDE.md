# Muʿarrib — Build Brief for Claude Code (v2)

> This file lives in the repo root as `CLAUDE.md` so the agent keeps the plan in context across the whole build. **This v2 replaces the version currently in the repo** — it adds a second translation provider (Google Gemini) and a privacy guardrail. Feed the agent the phase prompts in §8 one at a time, never all at once.

---

## 0. What you are building (context for the agent)

Muʿarrib is a web app that translates **English PDFs into native, correctly-rendered Arabic**. The core thesis: every other tool extracts the PDF's text and corrupts Arabic shaping/direction on output. Muʿarrib instead **renders each page to an image and has a vision model read the image** — so corruption never enters the pipeline. Output is a **reflowed Arabic reading view**, not a pixel-perfect copy of the layout.

A working single-file proof exists at `muarrib.html` (in this repo). It runs the full pipeline. **Reuse its frontend logic, its vision prompt (the `buildPrompt` function), and its styling.** Your job is to turn that proof into a real, deployable, multi-user, multi-provider app.

---

## 1. The one non-negotiable change from the proof

The proof calls the AI **directly from the browser with no key** — that only works inside the Claude.ai sandbox. A real app must **never** ship an API key in client code. Every model call goes through a **backend proxy** that holds/forwards the key server-side. This is the single most important architectural change.

---

## 2. Recommended stack (one path — don't deviate without a real reason)

- **Next.js (App Router) + TypeScript**, deployed on **Vercel**.
  - **Frontend:** a client component ported from `muarrib.html`.
  - **Backend:** one API route, `POST /api/translate-page`, that accepts a page image + page number + chosen provider, calls that provider, returns parsed JSON blocks.
  - **PDF rendering stays 100% client-side** (pdf.js). The full PDF is **never uploaded** — only individual page images go to the proxy. Privacy + cost.
- **Why:** one repo, one `vercel deploy`, scales serverlessly to thousands with zero server management.
- Claude Code docs: https://docs.claude.com/en/docs/claude-code/overview

---

## 3. Two providers (BYOK for both)

The user picks a provider and supplies their own key. The proxy routes accordingly.

- **Provider A — Anthropic** (existing flow). Highest quality. Key requires billing setup. **Paid tiers are not used for model training → use this for confidential/medical/patient documents.**
- **Provider B — Google Gemini** (new). **Free tier: a key from Google AI Studio needs only a Google account, no credit card.** Supports image input. Lower friction → this is what gets most users in the door, especially students.
  - **Privacy guardrail (required):** the Gemini **free** tier may use prompts to improve Google's models. The UI must warn that the free option is **not** for confidential or patient documents, and steer those to Anthropic.

### Model names — config constants, and DO NOT hardcode stale ones
- `gemini-2.0-flash-001` is **retired** (deprecated Feb 2026, removed March 3 2026). Do not use it.
- Use **`gemini-2.5-flash`** as the Gemini default (or current Flash model — verify the live model list). For Anthropic, use the current Sonnet (quality) or Haiku (cheapest) string.
- Put both in config: `GEMINI_MODEL`, `ANTHROPIC_MODEL`. Verify current names + free-tier limits before shipping:
  - Gemini models: https://ai.google.dev/gemini-api/docs/models
  - Gemini rate limits (free tier changes often — do not print a fixed number in the UI): https://ai.google.dev/gemini-api/docs/rate-limits
  - Anthropic models: https://docs.claude.com/en/docs/about-claude/models

---

## 4. The translation route (`/api/translate-page`)

- **Input:** JSON `{ imageBase64, pageNum, provider }` where `provider` is `"anthropic"` or `"gemini"`; plus the user's key in header `x-user-api-key`.
- **Provider abstraction:** a small adapter per provider. Each takes `(imageBase64, pageNum, apiKey)` and returns raw model text. They differ only in request shape and where the text lives in the response:
  - Anthropic Messages API: image as a base64 `image` content block; text at `content[].text`.
  - Gemini `generateContent`: image as `inline_data` (base64 + mime type); text at `candidates[0].content.parts[0].text`.
- **The prompt is shared** — paste the `buildPrompt` text from `muarrib.html` verbatim for both providers (it already enforces structure, number-exactness, bilingual terms, and never translating code/equations). Both providers can be told "return only a JSON array."
- **Fix the truncation limit from the proof.** Set a real `max_tokens` (e.g. 4096). For very dense pages, split the page image into top/bottom halves, translate each, and merge the block arrays in reading order.
- **Validate output.** Parse the JSON array; validate block types (heading, subheading, paragraph, list, table, caption, figure, equation, code; optional `lowconf`). On malformed JSON: repair (slice first `[` to last `]`) → one retry → structured error so the frontend can show per-page "Retry".
- **Never log file contents or the user's key.**
- **Output:** validated block array, or `{ error }`.

---

## 5. Frontend (port from `muarrib.html`)

**Keep all of this — it already works:** drag-drop upload, page-range + call estimate, 3-at-a-time concurrency pool, live progress with per-page status, **per-page Retry**, RTL Arabic reading view, **rebuilt RTL tables**, **preserved LTR equations & code**, **figure descriptions + Show-original toggle** (real graphic shown, never redrawn), **low-confidence flags** (`غير مؤكد`), **Print / Save-PDF** (browser renderer keeps Arabic correct — the trick competitors fail at).

**Change:** call `/api/translate-page` (passing the chosen `provider`) instead of calling the AI directly.

**Add — provider chooser at the top:**
- **"Use Gemini — free, just a Google account"** → reveals a Gemini key field + help text + link to `https://aistudio.google.com/apikey`. Under it, the warning: *free tier may be used to improve Google's models — don't use it for confidential or patient documents.*
- **"I have an Anthropic key"** → existing key field; note that it's higher quality and not used for training.
- Keys are stored in **session/memory only** and sent per-request via `x-user-api-key`. Never stored server-side.

---

## 6. Privacy stance (a FEATURE for medical/research users — state it plainly on the page)

"Your PDF never leaves your browser as a file. Only individual page **images** are sent to the AI provider you choose, only to be translated. Muʿarrib stores nothing and logs nothing. Note: your chosen provider processes the images under its own terms — the **free Gemini tier may use them to improve Google's models**, so for confidential or patient documents use the **Anthropic** option."

---

## 7. Build phases — each MUST run and be verifiable before the next

- **Phase 1 — Skeleton that translates (Anthropic first).** Scaffold Next.js + Vercel; port the frontend; route through the proxy with the Anthropic adapter; get one real PDF translating end-to-end. ✅ Live URL translates a page.
- **Phase 2 — Add the Gemini provider + chooser + BYOK + privacy note.** ✅ A stranger translates a page using a free Gemini key on the live URL.
- **Phase 3 — Robustness.** Truncation fix (bigger `max_tokens` + page-half split), schema validation, retry. ✅ A dense two-column medical page translates without truncating.
- **Phase 4 — Ship-ready polish.** Error states, mobile layout, loading copy, print stylesheet, a short landing section. ✅ You'd send the link to 10 real students/researchers without apologizing.
- **Phase 5 — Later, only if people use it.** Number cross-check (diff text-layer numbers vs vision output, auto-flag mismatches — the trust layer for medicine); `.docx`/PDF export; optional freemium + Stripe.

---

## 8. Exact prompts for Claude Code (in order)

1. *"In this repo, create a Next.js (App Router) + TypeScript app if not present. Add `POST /api/translate-page` accepting `{ imageBase64, pageNum, provider }` and header `x-user-api-key`. Build a provider abstraction with two adapters: `anthropic` (Messages API, vision) and `gemini` (generateContent, vision). Model names from config constants `ANTHROPIC_MODEL` and `GEMINI_MODEL`. Use this exact vision prompt for both: [paste `buildPrompt` from muarrib.html]. Parse the JSON array from each provider's response shape, validate block types, repair-then-retry once on malformed JSON, set max_tokens 4096, and return the array or a structured error. Never log file contents or keys."*
2. *"Build the frontend as a client component based on this file: [attach muarrib.html]. Keep upload, page-range + estimate, 3-concurrent pool, progress, per-page retry, RTL reading view, table/equation/code/figure rendering, low-confidence flags, Show-original toggle, Print. Change it to call `/api/translate-page` with the chosen provider instead of the AI directly. Keep styling and fonts."*
3. *"Add a provider chooser: 'Use Gemini (free — just a Google account)' with help text + link to https://aistudio.google.com/apikey and a warning that the free tier may be used to improve Google's models so it's not for confidential/patient documents; and 'I have an Anthropic key' (higher quality, not used for training). Each reveals a key field stored in session only and sent per request via x-user-api-key. Add the privacy note from the brief."*
4. *"Add dense-page handling: if a page risks truncation, split the page image into top and bottom halves, translate each, and merge the block arrays in reading order."*
5. *"Deploy to Vercel. Walk me through connecting the zayed971/muarrib repo and any env vars."*

---

## 9. Out of scope for v1 — do NOT build yet

Accounts/login, billing UI, usage dashboards, translation history, multiple target languages, scanned-PDF OCR tuning, mobile app, teams/sharing. Add only after real users ask. Adding them now is how v1 never ships.

---

## 10. Decisions only the owner makes

1. **Providers:** Anthropic + Gemini (BYOK) — confirmed.
2. **Default models:** `gemini-2.5-flash` + a current Anthropic Sonnet/Haiku — verify live names.
3. **Name + domain:** "Muʿarrib" works; check a domain is free.
