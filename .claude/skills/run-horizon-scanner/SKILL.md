---
name: run-horizon-scanner
description: Build, launch, drive, and screenshot the Horizon Scanner app (Vite React frontend + Deno API backend). Use when asked to run, start, launch, serve, smoke-test, screenshot, or locally verify Horizon Scanner / the evidence-brief web app.
---

# Run Horizon Scanner

Horizon Scanner is a **Vite React frontend** (`:3000`) that proxies `/api` to a **self-hosted Deno backend** (`:3002`, `supabase/functions/api/index.ts` started via `server-deno/server.ts`). The backend points at your Supabase instance + LLM proxy — configure both in `.env` before running.

Most logic lives in the **API layer** (retrieval/synthesis in `supabase/functions/_shared/`), so the primary driver is HTTP. The UI gates on login, so a screenshot lands on the **sign-in screen** unless you authenticate.

Drive it with `.claude/skills/run-horizon-scanner/driver.mjs` (backend health/version/search + Playwright screenshot) and the project's own `npm run smoke:api`. **All paths below are relative to the repo root.**

## Prerequisites
- **Node 20+** + **Deno 2.7+** on PATH, and a populated **`.env`** at the repo root (Supabase + LLM + Gemini keys — see `.env.example`).
- `npm install` (deps already present here).
- For the screenshot only: `npm i playwright --no-save && npx playwright install chromium`

## Run (agent path) — FIRST

**1. Start the backend** (`:3002`, connects to the VPS):
```bash
npm run start:api
```
Wait ~10 s for `Listening on http://localhost:3002/` + `journal-rankings warmed`.

**2. Verify it's live** (unauthenticated, no browser, no GPU):
```bash
node .claude/skills/run-horizon-scanner/driver.mjs health     # -> status:ok, supabase/gemini up
node .claude/skills/run-horizon-scanner/driver.mjs version    # -> buildMarker v125-..., rerank flags
npm run smoke:api                                             # project's own _health + _version smoke
```

**3. Start the frontend** (`:3000`, proxies `/api`→`:3002`):
```bash
npm run dev
```

**4. Screenshot the running UI** (headless chromium → `reports/horizon-screenshot.png`):
```bash
node .claude/skills/run-horizon-scanner/driver.mjs screenshot http://127.0.0.1:3000/ reports/horizon-screenshot.png
```
Prints `{title, hasInput, consoleErrors}`. **Expect the sign-in screen** ("Evidence Intelligence", Sign in / Create account) — the search UI is behind auth.

**5. (Optional) Run a real search** — requires an auth token AND hits the Qwen/embedding GPU on the VPS; use sparingly, never while a backfill is loading the GPU:
```bash
# Authenticated API routes need a Supabase token. The project smoke exercises them via:
API_SMOKE_TOKEN=<supabase-jwt> npm run smoke:api
```

## Run (human path)
Two terminals: `npm run start:api` and `npm run dev`, then open http://127.0.0.1:3000/ and log in. Useful for clicking through the brief UI; not needed for the agent path above. `Ctrl-C` each to stop.

## Build / test
```bash
npm run build        # vite production build (frontend only)
npm run check        # check-stale-references --strict + check:scripts + check:invariants + smoke:react + tsc --noEmit + build
```
`tsc --noEmit` is frontend-only (Deno/`scripts/` excluded). `npm run check` is the CI gate.

## Gotchas
- **The UI requires login** — a screenshot of `/` is the sign-in card, not the search box. `driver.mjs screenshot` confirms render via `title:"Horizon Scanner"` + zero console errors; don't expect `hasInput:true` (email/password are `type=email`/`type=password`, and the search textarea only exists post-auth).
- **No local DB by default.** The backend reads/writes whatever Supabase instance `SUPABASE_URL` points at. `/api/_health`, `/api/_version` are unauthenticated and safe; retrieval/write endpoints need a valid auth token and will hit the LLM GPU.
- **`llm` health can blip `down`** then `up` between calls (the probe is strict / the embed model can be momentarily cold). Re-run `health`; `supabase` + `gemini` are the load-bearing ones.
- **Deno launch flag**: `start:api` passes `--allow-write=/tmp`; it runs fine on Windows (Git Bash). The raw command is `cd server-deno && deno run --allow-net --allow-env --allow-read --allow-sys --allow-write=/tmp --env-file=../.env server.ts`.
- **Playwright isn't a project dep** — install it `--no-save` (above) so it doesn't touch `package.json`; the chromium binary caches under `~/AppData/Local/ms-playwright`.
- Vite binds `127.0.0.1` (`--host 127.0.0.1`), not `localhost`/`0.0.0.0` — use `127.0.0.1:3000`.

## Troubleshooting
- **`driver.mjs screenshot` → `Cannot find package 'playwright'`**: run the prereq install (`npm i playwright --no-save && npx playwright install chromium`).
- **`health` hangs / connection refused on :3002**: backend not up yet — check `reports/_run-backend.log` for `Listening on`; it warms journal rankings first (~330 ms after boot).
- **Frontend 404/blank**: confirm Vite logged `ready` and you're hitting `127.0.0.1:3000` (not `localhost`).
- **`search` returns 401**: expected — it needs a Supabase auth token, not just `x-tenant-id`.
