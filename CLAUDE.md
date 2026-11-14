# CLAUDE.md – Idea Generator 2

Node 25 runs the TypeScript server directly; the frontend is vanilla ES modules. There is no build step. Port 8300, loopback only.

## Commands

- `npm start` – server on http://localhost:8300 (`PORT`, `HOST`, `DB_FILE` override)
- `npm test` – 65 tests (`node --test`), fake LLM and fake provider servers, no network
- `npm run calibrate [-- --model provider:model]` – real judge against weak and strong reference ideas. It costs money. **Re-run it whenever the judge's prompt, schema or model changes.**

## Layout

- `server/providers.ts` – `provider:model` routing.
  - Ollama uses the native `/api/chat` with `think:false` and `format:schema`.
  - Anthropic uses the official SDK with `output_config.format`.
  - Everything else is OpenAI-compatible.
- `server/llm.ts` – every prompt, including the judge (`JUDGE_SYSTEM`). Each function takes `model`.
- `server/engine.ts` – every operation, the background judge queue (max 3) and the per-board event bus.
- `server/autopilot.ts` – the scheduler and the pure `rateCheck()`.
- `server/leads.ts` – the X and research scouts.
- `server/project.ts` – Claude Code folders.
- `server/cogito.ts` and `server/vetting.ts` – the optional CogitoEngine bridge: a child process (`python -m cogito.ideagen_bridge vet-one --stdin`), the run service, and the `vettings` table. Off unless `COGITO_DIR` is set.
- `server/db.ts` – SQLite (`node:sqlite`), plus `report()` and `dashboard()` queries.
- `server/app.ts` – HTTP, SSE (`/api/boards/:id/events`) and Markdown exports.
- `public/js/score.js` and `public/js/evolve.js` – pure modules shared by the server, browser and tests.
- `public/js/graph.js` – the canvas.
- `public/js/app.js` – the main app.
- `public/js/dashboard.js` and `public/js/report.js` – the trends and report views.

## Rules that matter

- **The medal comes from code, not the model:** a sum of three 1–5 scores, bronze from 9, silver from 11, gold from 13 (`score.js`). Left uncalibrated, an LLM jury gave 3/3 to the bare word "fire"; the calibration test keeps that from happening here.
- **Never put integer `minimum`/`maximum` in a JSON schema.** Anthropic rejects them. Put the range in the description and clamp in code.
- **Anthropic native: send no `temperature`.** API version 2026-10-21 rejects it. Use effort `low`. The SDK sends the key as a Bearer token.
- **OpenRouter: send `reasoning:{enabled:false}`** and retry without it on a 400 that mentions reasoning (some models insist on reasoning).
- **X scout:** a lead is kept only if its URL is in the search engine's `url_citation` annotations. Never trust a URL the model wrote. Only OpenRouter (Grok) can search X.
- **App settings live in the browser's localStorage.** The server holds them in memory, and the SSE `hello` tells the browser to push them again after a restart. Board configuration lives in the DB.
- **Dollar limits only see providers that report cost** (OpenRouter `usage.cost`, Anthropic via the price table). A limit of 0 means free models only.
- **Text goes into the DOM as text nodes, never `innerHTML`** (`dom.js`). Ideas are written by models and by visitors.
- **Project folders never overwrite.** They are created with a non-recursive `mkdir`, and a taken name gets `-2`.
- **Cogito never writes fitness.** A vetting is a record next to an idea (`vettings` table, `COGITO_VETTING.md`); it never touches scores, medals, the jury or the autopilot. Counter-proposals become seeds only when a person picks one, and the board's own jury then judges them. No pass/fail badge: the UI shows flags and open questions only.
- **Cogito's cost is invisible to the dollar budget** (its calls report no cost). The brake is `COGITO_MAX_RUNS_PER_DAY` (default 10, counted per arm, failed runs included). Browser-entered Anthropic/OpenAI keys go to the child's environment only. `COGITO_DIR`, `COGITO_PYTHON`, `COGITO_FLOW`, `COGITO_TIMEOUT_S`, and Cogito's own `COGITO_PROVIDER`/`COGITO_MODEL`/`MISTRAL_API_KEY` are read from the environment.

## Measured

- **Sonnet 5.5 judge** (2026-11-02):
  - weak ideas: mean 4.7, max 5
  - strong ideas: mean 9.8
  - run-to-run spread 0
  - about $0.003 per judgement
- **`ollama:qwen3:8b` as judge FAILS calibration:**
  - gave bronze to "Solpaneler på taken"
  - gave gold to 5 of 10 strong runs
  - spread 4 between runs
  - long reasons and Swedish errors

  Use local models to generate ideas, not to judge them.
- **X scout:** about 48 s and $0.04 per refresh; 5 of 6 leads were cited.
- **Providers tested live:** OpenRouter, OpenAI and Ollama (generation and model listing). Not yet tested against the live services: Azure / Microsoft Foundry, MLX, LM Studio, and Anthropic direct (only against a fake server). GitHub Models was removed: GitHub retired it on 30 July 2026 (every endpoint now answers a bare `200 OK`). Use the Test button in Settings.
