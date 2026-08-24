# Changelog — Horizon Scanner plugin

All notable changes to the Claude Code plugin. Bump `version` in
`.claude-plugin/plugin.json` to match the top entry on every release, then publish
(see README → "Publishing to a standalone repo"). Server-side changes (corpus,
retrieval, grounding, the writing contract at `/api/generation-spec`) reach users
immediately and are NOT listed here — only plugin-file changes are.

## 0.6.7
- **`horizon.md` Step 9 now proposes ONE save location and confirms before writing — and remembers the user's preference.** Previously the export defaulted to `./horizon-paper-<planId>`, which in a plugin session resolved to a buried temp/scratchpad dir users couldn't find. New behavior: the folder is resolved by precedence — `--out` flag → saved `outDir` preference → default `$HOME/Documents/Horizon Scanner` (never the scratchpad) — and, unless `--out` was passed or the user opted into silent saves, the assistant states the exact target path and gets a quick OK before writing. Filenames are now a descriptive title slug, not `horizon-paper-<planId>`. If no preference is stored yet, it offers to save the chosen folder as the default (`outDir` + `confirmOutDir`) in `~/.horizon-scanner/config.json`.
- **Credentials step** now also reads `outDir` / `confirmOutDir` from the config so Step 9 can honor the saved location + confirm preference.

## 0.6.6
- **Removed the standalone `jel-paper` skill.** It was never invoked by `commands/horizon.md` (which fetches the live writing contract from `/api/generation-spec` itself) and was only reachable as a confusing, non-functional standalone command (`/horizon-scanner:jel-paper` with no evidence set to work from). The writing contract remains fully documented inline in `commands/horizon.md`.
- **`horizon.md` Step 0 (new):** if no question is given (and no `--plan`), the very first action is now to ask "What's your research question?" — before touching credentials or anything else. Previously this depended on the model noticing the missing argument on its own.
- **`hooks/welcome.mjs` now checks for plugin updates every session** (independent of the existing one-time onboarding tip): compares the installed version against the published version on the standalone repo, throttled to ~once/24h via a local cache, prints a one-line notice only when outdated, silent otherwise or on any failure (offline, etc.). Fixed a Windows-only crash (libuv `UV_HANDLE_CLOSING` assertion) caused by a forced `process.exit()` racing the fetch's internal handles — removed the forced exit, letting the process end naturally.

## 0.6.5
- **Generation now matches the web pipeline, not just its writing rules.** The plugin already fetched the shared writing contract (`/api/generation-spec`); this release operationalizes the two pipeline stages it was skipping:
  - **Step 6b — evidence segmentation (Core / Context / Off):** applies the spec's segmentation policy (the plugin analog of the server's topicality tierer) — derive the core topic (strip geography/time/population), tier every paper, build the argument on Core, use Context for framing, never cite Off as core evidence. Adds a `Tier` column to the Excel export and orders rows Core → Context → Off, mirroring the app's evidence table.
  - **Step 6c — evidence enrichment (web):** the plugin analog of the server's work-dossiers — for the top Core papers it will cite, recover that paper's own effect sizes/identification the abstract omits, under the spec's hard name-match + hedge rules. Added `WebSearch` to the command's allowed-tools (the enrichment policy calls for web search; the command previously granted only `WebFetch`).
- **Paper length now matches the web app exactly.** The clarifier offered Brief ~10pg/5,000w and a *default* Standard ~20pg/10,000w — but the web app only produces 5 or 10 pages (500 words/page, default 10). Fixed to Brief (~5pg / ~2,500w) · Standard (~10pg / ~5,000w, recommended) · Custom.
- **New Step 5b — curation is persisted to the plan.** After the evidence gate, the assistant PATCHes `discoveredWorkIds` (kept grounded additions) and `removedWorkIds` (dropped papers) back to the plan (best-effort; never blocks drafting). The plan's evidence table is now identical whether reopened in the web app's Paper Studio or regenerated server-side — closing the loop the 0.6.1 PATCH allowlist opened. (Uploads already persisted via `/uploads`; dislikes via `/feedback`.)

## 0.6.4
- Step 5 evidence gate: when you drop a paper, the assistant now asks whether it's **just for this paper** or **also hide it from all similar future searches**. "All similar" records a dislike (with `searchRunId`) → the paper is suppressed on future cosine-similar queries, exactly like a thumbs-down in the web evidence table.
- Server (not auto-synced; needs deploy): `POST /api/feedback` now also accepts a direct `queryText` (in addition to `searchRunId`/`briefId`) so the query can be attached to a feedback row from any surface.

## 0.6.3
- Step 10 "Rate the papers" now sends `searchRunId` with each rating so the server can tie it to the query → feeds the per-query learning (both the positive promote boost and the dislike suppression), not just the methodology-weight agent.
- Server (not auto-synced; needs deploy): positive per-query learning — papers liked/saved/added on a similar past query get a bounded, relevance-gated rerank boost (`RB_PROMOTE_FEEDBACK=1`, default OFF). Plan additions (curated/discovered) are recorded automatically; `POST /api/feedback` now also accepts `searchRunId` and captures the query for like/save (not just dislike).

## 0.6.2
- New optional **Step 10 — Rate the papers**: after the paper is saved, the user can mark cited papers useful / not useful. Ratings post to `POST /api/feedback` (now in the plugin-key allowlist) and feed the per-user learning loop, which nudges study designs the user values higher in THEIR future searches (never affects other users). Fully opt-in and skippable; uploaded/unverified rows are skipped (not in the corpus).
- Server (not auto-synced; needs deploy): the plugin-key allowlist now permits `POST /api/feedback`; retrieval closes the learning-agent loop — approved `domain_weights` become a bounded methodology-domain rerank boost under `RB_DOMAIN_WEIGHTS=1`.

## 0.6.1
- Clarifier marks each dimension's default `(recommended)` and lists options with the recommended one first.
- After the six questions (or a `defaults` accept), the clarifier prints a single consolidated SUMMARY of all choices (`Dimension · Your choice · Maps to`) + working question + target length before retrieving — matching the web app's one-at-a-time → summarize flow.
- Server (not auto-synced; needs deploy): the plugin-key allowlist now permits `PATCH /api/paper-plans/:id`, scoped to evidence-curation fields only (`curatedWorkIds`/`discoveredWorkIds`/`removedWorkIds`), so accepted grounded/uploaded additions can be persisted to the plan (bundle + server-side regeneration then reflect them).

## 0.6.0
- Clarifier now asks scope questions ONE AT A TIME (region → population → evidence → recency → sources → length), with a `defaults` escape — parity with the web app.
- Evidence gate: a single review round shows the full table, then accepts remove / find-in-corpus (grounded) / upload-your-own-paper edits before drafting. Step 3 no longer prints a separate base table — the evidence is shown once, in the gate.
- Export: the spreadsheet is now the FULL evidence table (app columns + Abstract + a Cited flag), not cited-only. Uploaded papers appear as rows flagged unverified.

## 0.5.5
- **Citations no longer show the internal `[workId]`/DOI tag inline.** Reader-facing prose now
  reads `Author (year)` — the bracketed fence tag (e.g. `Jensen (2010) [10.1162/qjec.2010.125.2.515]`)
  is stripped from the final `.md`/`.docx` at export time, exactly as the web app does at render/download.
  The tag is still used *during drafting + self-review* (it proves every claim cites an in-set work and
  builds the Works Cited table) — it just never reaches the files the user opens; the DOI appears once,
  in the Works Cited table. Updated `commands/horizon.md` (Steps 7 + 9) and `skills/jel-paper/SKILL.md`.

## 0.5.4
- **First-run welcome in the terminal (no manual needed).** A `SessionStart` hook
  (`hooks/hooks.json` → `scripts/welcome.mjs`) prints a one-time, login-aware tip: if not
  logged in it shows the two setup steps; once logged in it shows *"✅ ready — just type
  `/horizon-scanner:horizon <your question>`"*. Shows once per machine (sentinel
  `~/.horizon-scanner/.welcomed`); fail-safe, never blocks the session; cross-platform (Node).
- **Shorter command: `/horizon-scanner:horizon`** (renamed from `…:horizon-paper`). Bare
  `/horizon` is not possible — Claude Code plugin commands are always namespaced — so this is
  the shortest reliable form.
- **No quotes needed.** `$ARGUMENTS` already captures the whole line; the misleading quotes were
  removed from the argument hint and all examples. Type the question in plain English.

## 0.5.3
- **Clarifier reliability (HARD RULES).** Step 1 was being collapsed — runs skipped the **Years/recency**
  question and the **Sources** confirmation, silently applying defaults. Now every one of the six
  dimensions MUST be shown with its default AND concrete options, and #4 (years: Recent 2020+ / From
  2000 / All years) and #5 (sources: the default set spelled out — ABS 3+ · IADB/WB/IMF/OECD ·
  NBER/IZA/CEPR/SSRN — plus "or choose specific tiers/repos/types") are called out as never-skip.
- **Base evidence table now shows Venue + Year** (columns: # · Authors · Year · Venue · Title · SMS).
- **Final evidence table before drafting (new, mandatory):** after the keep/drop gate, the plugin shows
  the COMPLETE set it will draw from — base retrieved + LLM-added together — as one numbered table with
  Authors (Year) · Venue · Title · SMS · Source (📚 retrieved / ➕ added), not just a paper count.

## 0.5.2
- **Review gate now re-shows the base evidence table alongside the proposed additions.**
  In a terminal the base table (from the search step) had scrolled out of view by the time
  the additions appeared, so the keep/drop decision was made without seeing what was already
  in the set. Step 5 now recaps the base papers, then lists additions — and flags each addition
  as on-topic vs merely adjacent (the grounding can surface same-keyword-but-different-literature
  papers, e.g. *returns-estimation* papers for an *information-intervention* question), plus
  calls out any relevant work cut as `over_cap`. Low-confidence adds are still shown — with a
  caveat — never silently dropped.
- **Lowered the creative-planner net-add cap 15 → 8** so the additions list stays focused and the
  adjacent-literature noise can't crowd out genuinely-missing seminal works.

## 0.5.1
- **Dropped the "Breadth" clarifying question** (Balanced vs Focused). The web app's
  direct/indirect/excluded classifier was removed (relevance-first redesign 2026-06-17) —
  evidence-table membership is now decided by a cosine relevance floor, so `evidenceMatch`
  no longer affects retrieval. Clarifying questions are now six (region, population, evidence
  type, recency, sources, length); the `evidenceMatch` mapping is gone from the request body.

## 0.5.0
- **Full quality self-review pass** added to the contract + flow — mirrors the app's
  *entire* QA suite: section recovery (completeness), claim audit (triage
  keep/soften/re-attribute/remove), Devil's Advocate, coherence, citation spread /
  cite-what-matters, corpus-gap weaving, citation-retention, DOI/Kris check, attribution,
  and final review — performed by the one capable local model. (The citation fence
  already prevented fabrication / bad DOIs, the Kris-class guarantee.)
- **DOIs in citations**: the Works Cited table now shows real `https://doi.org/…` DOIs
  (from the corpus `canonical_doi`, falling back to a `10.*` workId) instead of internal ids.
- **Paper-length option** in the clarifier (Brief ~10pg / Standard ~20pg / Custom).
- **Pre-generation notice** of the deliverables (Word `.docx` + Excel `.xlsx`).

## 0.4.0
- Paper footer is now **Works Cited only** (the papers actually cited) — the full
  all-papers pool table was dropped.
- **Export to Word** (`.docx`) for the paper and **Excel** (`.xlsx`) for the citations,
  with graceful fallback to `.md` / `.csv` when local converters aren't available.

## 0.3.0
- **Clarifying questions** before the search (region, population, evidence type,
  recency, breadth, sources) — parity with the web app; answers map to the search filters.
- **Step-by-step narration** (`▶` line before each step).
- In-terminal summary now shows **only the cited works** + how they were selected.

## 0.2.0
- **Single-source writing contract**: the plugin fetches `/api/generation-spec` so its
  output tracks the live pipeline (no plugin update needed when the contract changes).
- In-app "Set up Claude Code" setup made explicit (`/reload-plugins` step, namespaced
  `/horizon-scanner:…` commands, ordered setup snippet).

## 0.1.0
- Initial release: build evidence from the corpus + the user's own grounded creative
  planner → review gate → draft a JEL survey paper, entirely in the terminal on the
  user's Claude subscription. `/horizon-scanner:horizon-paper` + `/horizon-scanner:horizon-login`
  (durable, revocable, endpoint-scoped key).
