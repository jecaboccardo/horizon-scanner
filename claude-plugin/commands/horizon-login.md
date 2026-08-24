---
description: Save your Horizon Scanner plugin key once, so /horizon-scanner:horizon just works (no env vars, no devtools).
argument-hint: <hsk_key> [--base <url>] [--tenant <id>]
allowed-tools: Bash
---

Save the user's Horizon Scanner credentials to a local config file so they never
have to set environment variables or paste a token again.

## Arguments
- `$1` = the plugin key (starts with `hsk_`). The user copied it from the web app's
  **"Set up Claude Code"** button. If `$1` is missing, ask them to paste it (and tell
  them where to get it: app → account → Set up Claude Code).
- `--base <url>` = API base (default `https://horizon-api.nextminder.com`).
- `--tenant <id>` = tenant id (default `iadb-demo`).

## What to do
1. Validate the key looks like a plugin key: it MUST start with `hsk_`. If it doesn't,
   stop and tell the user it's not a plugin key (a browser session token won't work here —
   use the "Set up Claude Code" button).
2. Write `$HOME/.horizon-scanner/config.json` with `{ apiBase, token, tenantId }`:
   ```bash
   mkdir -p "$HOME/.horizon-scanner"
   cat > "$HOME/.horizon-scanner/config.json" <<JSON
   {
     "apiBase": "<--base or default>",
     "token": "<$1>",
     "tenantId": "<--tenant or default>"
   }
   JSON
   chmod 600 "$HOME/.horizon-scanner/config.json"
   ```
3. Confirm: print "Saved. You can now run /horizon-scanner:horizon." — and DO NOT echo the full
   key back (show only its prefix, e.g. the first 10 characters).

The key is a durable, revocable credential scoped to the paper-building endpoints only —
it cannot reach the rest of the API and is never an admin. To revoke it, the user deletes
it in the web app's account page.
