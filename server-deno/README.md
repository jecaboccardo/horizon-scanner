# server-deno — Plain Deno runtime for the api function

Production Deno runtime for the Horizon Scanner backend API. Runs the same Edge
Function handler that ships to Supabase cloud, but in our own Deno binary on the VPS.

## Why plain Deno

- The api handler in `supabase/functions/api/index.ts` and `_shared/*.ts` uses
  Deno-style imports (`npm:`, relative `.ts` paths, `Deno.env`). Running it
  under Node.js requires brittle workarounds (Node ESM rejects `npm:`
  specifiers natively).
- `supabase/edge-runtime` self-hosted (v1.71.2) failed with cross-directory
  imports — works on Supabase cloud only because the CLI compiles to eszip
  before deploy.
- Plain Deno (`deno run`) handles `npm:` specifiers and the import map natively
  with zero source changes.

## Files

- `server.ts` — entry: imports the existing handler and starts `Deno.serve()`
- `deno.json` — import map for clean specifiers (`@supabase/supabase-js`, etc.)

## Run locally

```bash
cd server-deno
DENO_API_PORT=3002 deno run \
  --allow-net --allow-env --allow-read --allow-sys --allow-write=/tmp \
  --env-file=../.env \
  server.ts
```

## Run in production (VPS, LXC 134)

systemd service `deno-api.service`. The deploy hook (`deploy-horizon.sh` on
the VPS) runs `git reset --hard origin/main` then `systemctl restart deno-api`.

The systemd unit overrides `SUPABASE_URL=http://localhost:8000` to bypass the
NAT-loopback issue: the public IP `15.235.47.35:8000` is unreachable from
inside the LXC; localhost goes straight to the Kong container.

## Env vars

Loaded from `/opt/horizon-scanner/repo/.env`:

| Var | Purpose |
|-----|---------|
| `SUPABASE_URL` | Kong gateway (`http://localhost:8000` in prod, NAT bypass) |
| `SUPABASE_ANON_KEY` | anon JWT for user-scoped client |
| `SUPABASE_SERVICE_ROLE_KEY` | admin JWT for `adminClient` |
| `GEMINI_API_KEY`, `GEMINI_MODEL` | synthesis (briefs/chat; default `gemini-flash-latest`) |
| `GEMINI_JEL_MODEL`, `GEMINI_JEL_QA_MODEL` | JEL drafting = `gemini-pro-latest`, JEL QA = flash (see `.claude/rules/ai-gateway.md`) |
| `OPENAI_API_KEY` | fallback |
| `SEMANTIC_SCHOLAR_API_KEY`, `EXA_API_KEY`, `OPENALEX_API_KEY`, `OPENALEX_EMAIL` | retrieval |
| `GROQ_API_KEY`, `GROK_API_KEY`, `NOMIC_API_KEY` | other LLM clients |

Optional: `DENO_API_PORT` (default `3002`).
