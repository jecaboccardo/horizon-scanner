# Horizon Scanner — Claude Code plugin

Generate IADB-grade JEL survey papers **from your own Claude Code terminal, on your
own Claude subscription** — instead of (or alongside) the Horizon Scanner web app.

This is a **power-user option**. The web app still works standalone for everyone:
it generates papers server-side (Gemini/Qwen) with no setup. This plugin is for
analysts who have Claude Code + a Pro/Max subscription and want the paper written
by their own Claude (better long-form synthesis, and the LLM cost lands on their
subscription, not the app's API budget).

## How it splits the work

Everything can happen in the terminal — no web round-trip required.

| Step | Where it runs | Who pays |
|------|---------------|----------|
| Retrieve the base evidence table from the ~500K-paper corpus | Horizon Scanner server (read-only, no LLM) | — |
| Propose missing seminal works / sub-literatures | **Your Claude Code** | Your subscription |
| Corroborate those proposals vs the corpus | Horizon Scanner server (read-only) | — |
| Review which additions to keep | You (a checklist in the terminal) | — |
| Write the paper | **Your Claude Code** | Your subscription |

"You propose, the corpus disposes": your Claude can suggest missing seminal works,
but only papers that resolve to a real corpus row can be added or cited — no fabrication.

## Install

```
/plugin install horizon-scanner@<marketplace>
```
…or, during development, point Claude Code at this directory as a local plugin.

## One-time setup

Export your Horizon Scanner credentials (get them from the web app → account):

```bash
export HORIZON_API_BASE="https://<YOUR_DENO_API_URL>"   # or http://localhost:3002
export HORIZON_API_TOKEN="<your access token>"
export HORIZON_TENANT_ID="iadb-demo"
```

## Use

**Terminal-first (default — no web app needed):**
```
/horizon-scanner:horizon returns to schooling information interventions in Latin America
```
Claude retrieves the base table from the corpus, proposes grounded additions, shows
you a **review checklist** to keep/drop them, then writes the paper.

**From a web-curated table (optional handoff):** if you already built a table in
Paper Studio, pass its plan id instead:
```
/horizon-scanner:horizon --plan <planId>
```

Options: `--no-expand` (skip the creative-planner additions), `--out <path>` (output file).

The finished paper is written to `./horizon-paper-<id>.md` (plus `.docx` and a full evidence-table `.xlsx`).
You can upload it back into the Horizon Scanner Library, or keep it locally.

## What it talks to (golden-rule-safe — never writes the corpus)

- `GET  /api/paper-plans/:id/bundle` — the curated evidence + plan north-star (read-only).
- `POST /api/paper-plans/:id/ground` — corroborate your proposed additions against
  the corpus (read-only; no server-side LLM; the proposing happens in your Claude Code).
- `POST /api/paper-plans/:id/uploads` — attach a paper of your own that isn't in the corpus
  (writes `plan.uploads` + an upload signal only — **never** the `works` corpus; flagged unverified).
- `GET  /api/generation-spec` — the live JEL writing contract (same single source the
  server's own drafter uses), so the plugin's output tracks the pipeline automatically.

## Updating the plugin (getting new changes to users)

Plugins are **not** auto-updated — a user's install is a clone from install time.

**Maintainer (on every change):** bump `version` in `.claude-plugin/plugin.json` (semver),
commit, and push. The version bump is what lets Claude Code flag "update available." New
installs always get the latest commit; existing users only update when they ask.

**User (to pull the latest):**
```
/plugin marketplace update horizon-scanner
/plugin update horizon-scanner            # or re-run /plugin install horizon-scanner@horizon-scanner
/reload-plugins
```

> Because the read-only API endpoints and the writing contract (`/api/generation-spec`) are
> served by the app, **server-side improvements reach every user immediately** with no plugin
> update. Only changes to the plugin's *own files* (the commands, the skill text, the export
> logic) require a version bump + a user update.

## Publishing to a standalone repo (clean client distribution)

`claude-plugin/` is **self-contained** (it carries its own `.claude-plugin/marketplace.json`
with `source: "."`), so it can be published as the *root* of a dedicated repo — clients then
install from that repo and never see the app's source. **The main repo stays the single source**
— you publish a mirror, you don't maintain two copies (no drift).

**One-time:** create the GitHub repo (e.g. `iadb/horizon-scanner-plugin`).

**On each release** (after bumping `version` + CHANGELOG, from the main repo root):
```bash
git subtree push --prefix=claude-plugin https://github.com/iadb/horizon-scanner-plugin.git main
```
That pushes only the `claude-plugin/` subtree to the standalone repo's `main`. Clients then:
```
/plugin marketplace add iadb/horizon-scanner-plugin
/plugin install horizon-scanner@horizon-scanner
```
…and update with `/plugin marketplace update horizon-scanner` + `/reload-plugins`.

> If `git subtree push` is slow on a large history, the alternative is a clean mirror: copy
> `claude-plugin/*` into a fresh checkout of the standalone repo, commit, and push. Set
> `VITE_PLUGIN_MARKETPLACE=iadb/horizon-scanner-plugin` in Vercel so the in-app "Set up Claude Code"
> snippet points clients at the standalone repo.

## Notes / limits

- **Anthropic terms**: you run your own Claude Code on your own data — confirm this
  use fits the current Consumer Terms before relying on it at scale.
- **Re-import** of the finished paper into the web Library is Phase 2 (for now, save
  locally / upload manually).
- Prompts here are a faithful port of the server pipeline's methodology, tuned for a
  capable local model; they may diverge from the web app's Gemini/Qwen prompts over time.
