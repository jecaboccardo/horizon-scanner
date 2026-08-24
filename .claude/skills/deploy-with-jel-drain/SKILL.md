---
name: deploy-with-jel-drain
description: Safely deploy the backend (push to main) without killing in-flight JEL survey-paper generation. Use BEFORE any git push to main, or when the user asks to deploy / ship the backend. Every push restarts deno-api and kills fire-and-forget JEL jobs.
---

# Deploy with JEL drain

**Why this exists:** the VPS webhook runs `deploy-horizon.sh` on every push to `main` →
`git reset --hard origin/main` + `systemctl restart deno-api`. JEL generation is an
in-process fire-and-forget job, so the restart **kills any paper mid-generation**.

Frontend (Vercel) auto-deploys too, but that's harmless — this is about the backend.

## Pre-push checklist

1. **Check for in-flight JEL papers** before pushing:
   ```bash
   # via the DB (Kong/PostgREST, service role):
   # GET /rest/v1/jel_papers?status=in.(running,queued)&select=id,tenant_id,status,created_at
   ```
   Use the `SUPABASE_URL` + service key from `.env`. If any are `running`/`queued`:
   - Wait for them to finish, OR
   - Confirm with the user that interrupting is OK (the paper will end in `error` and can be regenerated).

2. **`deploy-horizon.sh` has a `drain_jel()`** that waits (bounded by `DRAIN_MAX_S`)
   for `running` jel_papers before the restart, and the startup watchdog
   (`api/index.ts`) resets ALL `running` → `error` (regenerable). So a push while a
   paper runs will **delay the deploy** (drain wait) and then the paper ends `error`.
   The version-controlled copy is `deploy/deploy-horizon.sh`.

3. **Run the gate** before pushing: `npm run check` must be green.

4. Push: `git push origin main`.

5. **Confirm the deploy landed** — the `BUILD_MARKER` bumps per deploy:
   ```bash
   curl -s <YOUR_API_URL>/api/_version   # check buildMarker changed
   curl -s <YOUR_API_URL>/api/_health    # supabase/llm/gemini all "up"
   ```

## Rule of thumb
Avoid pushing while a JEL paper is generating. If you must, tell the user it will
delay (drain) and the paper will need a regenerate/revise afterward.
