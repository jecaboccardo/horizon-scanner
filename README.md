<div align="center">
<img width="1200" height="475" alt="Horizon Scanner" src="https://github.com/user-attachments/assets/0aa67016-6eaf-458a-adb2-6e31a0763ed6" />
</div>

# Horizon Scanner

Horizon Scanner is an evidence-scanning and synthesis tool built for the Inter-American Development Bank (IADB / BID). It retrieves research papers from a curated corpus of 535k+ canonical papers, ranks them by methodology and relevance using a relevance-first vector model, and generates structured 5-section policy briefs with full audit trails.

Designed for policy analysts who need citation-grounded evidence summaries on development economics topics. Multi-tenant, with a Paper Studio for survey-paper generation and a Claude Code plugin for terminal-based workflows.

---

## Architecture

```
Browser → Vercel (frontend, /api/* proxied to backend)
              ↓
         Deno API  ←  server-deno/server.ts → supabase/functions/api/index.ts
              ↓
         Self-hosted Supabase (Kong/PostgREST → Postgres + pgvector)
              ↓
         LLM layer  (see "LLM Layer" below)
```

### Tech Stack

| Layer | Technology | Notes |
|-------|-----------|-------|
| Frontend | React 19 + TypeScript, Vite | Port 3000; proxies `/api` to backend |
| Backend | Deno 2.7+, systemd | Port 3002; single handler file |
| Data | Self-hosted Supabase + Postgres + pgvector | 535k canonical papers |
| Embeddings | Qwen3-Embedding 8B (768-dim) via LiteLLM | Dedicated GPU instance |
| Extraction / chat | Qwen 2.5 14B via LiteLLM | Shared GPU |
| Synthesis | Gemini (flash briefs; Pro for JEL section drafting) or Claude via BYOK | Brief + paper generation |
| Styling | Tailwind CSS | Teal/navy theme |

---

## Local Development

### Prerequisites

- **Node.js 20+** — frontend and tooling scripts
- **Deno 2.7+** — backend API
- Access to a running **self-hosted Supabase** stack (or credentials to the shared instance)
- An **LLM proxy endpoint** with `LLM_API_KEY` — without this, search returns 0 papers

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

Copy `.env.example` to `.env` and fill in:

| Variable | Required | Description |
|----------|----------|-------------|
| `SUPABASE_URL` | ✅ | Kong/PostgREST gateway (e.g. `http://localhost:8000`) |
| `SUPABASE_SERVICE_ROLE_KEY` | ✅ | Service role JWT for the Supabase instance |
| `SUPABASE_ANON_KEY` | ✅ | Anonymous JWT (frontend auth flow) |
| `LLM_BASE_URL` | ✅ | OpenAI-compatible LLM proxy URL |
| `LLM_API_KEY` | ✅ | Bearer token for the LLM proxy — **search returns 0 papers without this** |
| `OLLAMA_EMBEDDING_MODEL` | ✅ | Embedding model name (must match the 768-dim corpus: `qwen3-embedding:8b-app`) |
| `GEMINI_API_KEY` | ⚡ | Gemini API key for brief synthesis. Falls back to deterministic output if absent. |
| `SYNTHESIS_KEY_SECRET` | ⚡ | 32-byte base64 master key for BYOK encrypted key storage (see BYOK below) |
| `VITE_API_BASE_URL` | ✅ | Must be `/api` (relative) — an absolute URL breaks CORS on non-primary domains |
| `VITE_DEFAULT_TENANT_ID` | — | Default tenant (e.g. `iadb-demo`) |
| `ALLOWED_ORIGINS` | — | Comma-separated allowed CORS origins. Defaults to `*` if unset. Set on any deployed backend: `https://your-app.vercel.app` |

See `.env.example` for the full list including optional telemetry, worker, and analytics keys.

---

## LLM Layer

The system has three layers that can be configured independently.

### 1 · Embeddings and extraction (Qwen via LiteLLM)

`LLM_BASE_URL` points to an OpenAI-compatible proxy. Today this is a self-hosted LiteLLM instance fronting:
- **Qwen3-Embedding 8B** at `dimensions=768` — query embedding + all corpus vectors
- **Qwen 2.5 14B** — query expansion, SMS classification, extraction, chat

> ⚠️ The corpus is fully embedded at 768 dimensions with Qwen3-Embedding. Switching embedding models requires re-embedding all 535k papers — a ~48h GPU job. The model name must stay consistent across all writes and reads.

**To point at IADB infrastructure:** change `LLM_BASE_URL` and `LLM_API_KEY` in `.env` to your LiteLLM endpoint and key. No code changes required — the client uses standard `/v1/chat/completions` and `/v1/embeddings`.

### 2 · Brief and paper synthesis (Gemini / Claude)

Synthesis (the 5-section policy brief, JEL survey papers, chat) uses:
- `GEMINI_API_KEY` → Gemini via the Gemini API directly. Model per task (all overridable,
  default `gemini-flash-latest`): briefs/chat = `gemini-flash-latest` (`GEMINI_MODEL`);
  JEL section drafting = `gemini-pro-latest` (`GEMINI_JEL_MODEL`); JEL QA passes =
  `gemini-flash-latest` (`GEMINI_JEL_QA_MODEL`). See `.claude/rules/ai-gateway.md`.
- Or a BYOK key (see below)
- Deterministic fallback always ships if both are absent

**To use IADB's own Gemini or Claude key:** use the BYOK flow below, or set `GEMINI_API_KEY` directly.

### 3 · BYOK synthesis — shared team key

An admin (e.g. `rafaelde@iadb.org`, marked `byok_admin` in Supabase Auth) can provision **one encrypted Gemini or Claude key** that the whole team shares. Granted users' briefs, chat, and paper generation all run on the admin's key — users pay nothing, the admin's account is billed.

- **Set key:** `POST /api/synthesis-keys` (admin JWT only) — UI in the "Grant access" nav tab
- **Grant users:** `POST /api/synthesis-grants` with the grantee's email
- **Key failure is a hard error** — a bad key blocks generation rather than silently falling back to app-default (which would re-bill the app)

This is the recommended bridge while transitioning to IADB infrastructure: the IADB account holds the key, analysts use the app as normal.

---

## Claude Code Plugin

Power-user path for analysts who want to generate JEL survey papers from their **own Claude subscription** (cost lands on their plan, not the app's). The plugin calls Horizon Scanner's API for evidence retrieval, then uses the analyst's local Claude session for drafting.

**Installed from:** [`github.com/jecaboccardo/horizon-scanner-plugin`](https://github.com/jecaboccardo/horizon-scanner-plugin)

```bash
/install-plugin github.com/jecaboccardo/horizon-scanner-plugin
/reload-plugins
/horizon-login        # save your API key once
/horizon-scanner:horizon <your research question>
```

The plugin is published as a standalone repo. The source lives in `claude-plugin/` in this repo and is published via:

```bash
git subtree push --prefix=claude-plugin <plugin-repo-url> main
```

Plugin commands auto-sync server-side contract changes (`GET /api/generation-spec`). Only command-file edits need a republish.

---

## Deployment

### Frontend — Vercel

Auto-deploys from `git push` to `main`. Set these env vars in the Vercel project:

```
VITE_API_BASE_URL=/api          # always relative — never an absolute URL
VITE_DEFAULT_TENANT_ID=iadb-demo
VITE_POSTHOG_KEY=...            # optional analytics
```

To update the demo alias after deploy:
```bash
npx vercel ls
npx vercel alias <deployment-url> horizon-scanner-iadb-demo
```

### Backend — Deno on VPS

Auto-deploys via a git webhook: on push to `main`, the server runs `git reset --hard origin/main` and restarts the `deno-api` systemd unit (port 3002). See `server-deno/README.md` for systemd unit setup and nginx reverse-proxy config.

**Set `ALLOWED_ORIGINS` on the VPS** to restrict CORS to your Vercel domains:
```
ALLOWED_ORIGINS=https://your-app.vercel.app,https://your-demo.vercel.app
```

### Transitioning to IADB infrastructure

The backend is a plain Deno process with no cloud-provider lock-in. To move it:
1. Provision a Linux host with Deno 2.7+ and self-hosted Supabase (Docker Compose — see `supabase/`)
2. Point `SUPABASE_URL` at the new Supabase Kong gateway
3. Point `LLM_BASE_URL` + `LLM_API_KEY` at IADB's LiteLLM endpoint (or set up a new one)
4. For synthesis, either set `GEMINI_API_KEY` (IADB's key) or provision a BYOK Claude key
5. Copy the Postgres data (pg\_dump / pg\_restore) and rebuild the pgvector HNSW index
6. Set `ALLOWED_ORIGINS` to IADB's frontend domain

The embedding model constraint applies: `OLLAMA_EMBEDDING_MODEL` must continue to serve `qwen3-embedding:8b` at `dimensions=768`, or the full corpus re-embedding job must be run first.

---

## Running checks

```bash
npm run check     # stale-ref check → script parse → invariants → smoke → tsc → build
npm run eval      # retrieval quality eval (gold queries)
```

CI runs `npm run check` on every push to `main` (`.github/workflows/ci.yml`).
