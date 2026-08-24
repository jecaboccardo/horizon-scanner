# Horizon Scanner — Architecture Reference

## What This Is

Horizon Scanner is an evidence-scanning and synthesis tool built for the Inter-American Development
Bank (IADB). It retrieves research papers from a curated corpus of ~505k canonical papers (non-noise;
run `/corpus-gap-count` for the live figure, incl. denylisted-noise total), ranks
them by methodology and relevance, and generates structured 5-section policy briefs with full audit
trails. The system is multi-tenant and designed for policy analysts who need citation-grounded
evidence summaries on development economics topics.

---

## Architecture

```
Browser → Vercel (frontend, /api/* proxied to backend)
              ↓
         Deno API (server-deno/server.ts → supabase/functions/api/index.ts)
              ↓
         Self-hosted Supabase (Kong/PostgREST → Postgres + pgvector)
              ↓
         LLM layer (see README.md → LLM Layer)
```

All API requests from the browser go through Vercel's `/api` proxy, which forwards them to the
Deno backend. The backend handles all route logic in a single handler file and calls out to the
Supabase data layer and LLM services.

### Tech Stack

| Layer | Technology | Notes |
|-------|-----------|-------|
| Frontend | React 19 + TypeScript, Vite | Port 3000; proxies `/api` to backend |
| Backend | Deno 2.7+, systemd | Port 3002; runs the Deno API handler directly |
| AI — Embeddings + extraction | LiteLLM proxy (OpenAI-compatible) for Qwen 2.5 14b | Bearer auth via `LLM_API_KEY` |
| AI — Synthesis | Gemini (`gemini-flash-latest` briefs; `gemini-pro-latest` JEL section drafting, flash for JEL QA) or Claude via BYOK | Brief + JEL generation; deterministic fallback always present. Model routing → `.claude/rules/ai-gateway.md` |
| Data | Self-hosted Supabase + Postgres + pgvector | ~505k canonical papers, evidence cards, briefs |
| Styling | Tailwind CSS | Teal/navy gradient theme |

---

## Key Files

### Backend (Deno — runs in production and local dev)

| File | Purpose |
|------|---------|
| `server-deno/server.ts` | Entry point — starts `Deno.serve()` on `DENO_API_PORT` |
| `server-deno/deno.json` | Import map for npm: and bare specifiers |
| `supabase/functions/api/index.ts` | All API route handlers |
| `supabase/functions/_shared/retrieval.ts` | Search intent + candidate ranking |
| `supabase/functions/_shared/synthesis.ts` | Brief generation (Gemini + deterministic fallback) |
| `supabase/functions/_shared/rerank.ts` | Relevance-first unified reranker + channel boosts |
| `supabase/functions/_shared/qwenClient.ts` | LiteLLM client for Qwen (extraction, expansion) |
| `supabase/functions/_shared/ollamaClient.ts` | LiteLLM client for embeddings |
| `supabase/functions/_shared/geminiClient.ts` | Gemini synthesis client |
| `supabase/functions/_shared/prompts.ts` | Prompt families and persona instructions |
| `supabase/functions/import_map.json` | Cross-runtime imports (npm:, jsr:, etc.) |

### Frontend

| File | Purpose |
|------|---------|
| `App.tsx` | Main app — tabs, search state, brief lifecycle |
| `types.ts` | All TypeScript interfaces (Work, SearchRun, EvidenceBrief, etc.) |
| `services/apiClient.ts` | Frontend HTTP client |
| `services/exportService.ts` | JSON / CSV / Word (.docx) export |
| `components/BriefView.tsx` | Evidence brief display (5 sections + evidence table) |
| `components/Sidebar.tsx` | Filter panel (topics, regions, tiers, methodology) |
| `components/PaperStudio.tsx` | Survey-paper preparation wizard |

### Workers and Scripts

| File | Purpose |
|------|---------|
| `scripts/extraction-worker.mjs` | Long-running Qwen extraction worker |
| `scripts/count-corpus-gaps.mjs` | Report null-abstract / SMS / geography / embedding gaps |
| `scripts/backfill-*.mjs` | Corpus metadata backfill scripts (abstracts, authors, geography, SMS) |
| `scripts/apply-migrations.mjs` | Apply `supabase/migrations/*.sql` to the Postgres DB |
| `claude-plugin/` | Claude Code plugin for analyst-side paper generation |

---

## Local Development

### Prerequisites

- **Deno 2.7+** — for the backend
- **Node 20+** — for the frontend and tooling scripts
- **Access to a running self-hosted Supabase stack** — or credentials to the shared instance
- **An LLM proxy endpoint** with `LLM_API_KEY` — without this, search returns 0 papers

### Steps

```bash
# 1. Copy and fill in environment variables
cp .env.example .env
# Edit .env — see Environment Variables below

# 2. Start the backend (in one terminal)
cd server-deno
deno run --allow-net --allow-env --allow-read --allow-sys --allow-write=/tmp \
  --env-file=../.env server.ts
# Listening on DENO_API_PORT (default 3002)

# 3. Start the frontend (in another terminal)
npm install
npm run dev
# Open http://127.0.0.1:3000
```

---

## Environment Variables

See `.env.example` for the complete list. Required to run:

| Variable | Description |
|----------|-------------|
| `SUPABASE_URL` | Kong/PostgREST gateway (e.g. `http://localhost:8000`) |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role JWT |
| `SUPABASE_ANON_KEY` | Anonymous JWT (frontend auth flow) |
| `LLM_BASE_URL` | OpenAI-compatible LLM proxy URL |
| `LLM_API_KEY` | Bearer token — **required for search** |
| `OLLAMA_EMBEDDING_MODEL` | Must be `qwen3-embedding:8b-app` (768-dim, matches corpus) |
| `GEMINI_API_KEY` | Gemini API key for synthesis (deterministic fallback if absent) |
| `VITE_API_BASE_URL` | Must be `/api` — never an absolute URL |
| `ALLOWED_ORIGINS` | Comma-separated CORS origins for the backend (e.g. `https://your-app.vercel.app`) |

---

## Deployment

**Frontend:** auto-deploys to Vercel on `git push main`.

**Backend:** auto-deploys via git webhook on the VPS — push to `main` triggers
`git reset --hard origin/main` + `systemctl restart deno-api`. See `server-deno/README.md`.

> Run `npm run check` before pushing — tsc + build + invariant checks must be green.

---

## Corpus integrity — golden rules

1. **Retrieval never clobbers curated data.** Hot-path `works` upserts only fill gaps.
2. **Abstracts and authors are RETRIEVED text, never generated.** No LLM "recall" of
   bibliographic text from training data — ever. (2026-07-15 incident: ~9,500 recalled
   abstracts were ~99% fabricated where checkable; quarantined via
   `scripts/verify-recalled-abstracts.mjs`.) Abstract/author writers must be
   retrieval-based (publisher APIs, scrapers, OpenAlex/S2/Crossref, xlsx) and stamp
   `raw_data.abstract_source` provenance. Non-retrieved provenance surfaces as
   `unverified` in JEL evidence-table exports.

## Claude Code tooling

This repo includes Claude Code configuration in `.claude/`:

- **`/run-horizon-scanner`** — start and smoke-test the app locally
- **`/apply-migration`** — apply a DB migration to Postgres
- **`/corpus-gap-count`** — report live corpus metadata gaps
- **`/deploy-with-jel-drain`** — safe deploy checklist
- **`corpus-backfill` agent** — run metadata backfills safely
- **`denylist-curation` agent** — flag non-research corpus noise

See `.claude/README.md` for the full reference.
