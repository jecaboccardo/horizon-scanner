# API Contracts

All endpoints require `x-tenant-id` header (default: `iadb-demo`). Local
prod-parity API runs on the Deno backend at `localhost:3002`.

## GET /api/snapshot

Full tenant state dump. Used by frontend on load.

## GET /api/_health, GET /api/_version

`/api/_health` → `{ status, supabase, llm, gemini }` (each `up`/`down`, via
individually-timeboxed probes — never hangs). `/api/_version` → `{ buildMarker, rerank,
judge, thresholds, classifier, ... }`; the `BUILD_MARKER` string is bumped per backend
deploy and is the deploy-confirmation signal. `rerank`/`judge` (added 2026-07-09) expose
live prod ranking + band-judge config (`judge: { bandJudge, backend, dropOnly, dropThr }`)
— use this instead of SSH for config sanity checks. `jelBatch: { enabled, deadlineMs,
pollMs }` (added 2026-07-13, v159) exposes the JEL Gemini Batch-Mode drafting config
(see `.claude/rules/ai-gateway.md` → cost levers). Both unauthenticated.

## POST /api/events

First-party telemetry ingest for FRONTEND usage events (the server logs its own
events directly). Authenticated. Body: `{ eventType, status?, latencyMs?, error?,
targetType?, targetId?, payload? }` → fail-safe insert into `usage_events`. **Always
returns 202** — a telemetry failure must never fail the caller. Raw context (incl.
query text) stays in our Postgres; external sinks (PostHog/Sentry) get a scrubbed copy.

## POST /api/search-runs

Run discovery and retrieval.

Request:

```json
{
  "query": "string",
  "filters": "SearchFilters"
}
```

Response: `SearchRun` with intent, candidate/evidence/signal IDs, embedded work
rows, coverage stats, and audit trace.

## GET /api/search-runs/:id

Fetch a specific search run.

## GET /api/search-runs/:id/more-evidence

Load-more (2026-06-11). Returns the pre-ranked extended evidence (papers 51–200) stored in
`search_runs.extended_evidence_work_ids` at search time — no re-retrieval (~200ms DB read +
works fetch). `{ works: Work[], total }`. Drives the BriefView "Load more papers" button via
`apiClient.loadMoreEvidence()`; `SearchRun.hasMoreEvidence`/`extendedEvidenceCount` gate it.

## DELETE /api/search-runs/:id

Delete a run and its generated children.

## POST /api/briefs

Generate a brief from a completed search run.

Request:

```json
{ "searchRunId": "string" }
```

## GET /api/briefs/stream

SSE streaming brief generation.

## GET /api/briefs/:id

Fetch a stored brief.

## POST /api/briefs/:id/chat

Ask a grounded follow-up question about a brief.

## Alerts, Feedback, Admin

- `POST /api/alerts/subscriptions`
- `DELETE /api/alerts/subscriptions/:id`
- `POST /api/feedback`
- `POST /api/admin/source-review`
- `GET /api/admin/alerts`
- `POST /api/admin/retrieval-audits/:id/feedback`
- `GET /api/saved-papers`
- `DELETE /api/saved-papers/:feedbackId`

## Monitoring (SCL pilot) — read-only, admin

Observability over `usage_events` + `llm_calls`, scoped to a roster of user UUIDs
(env `SCL_ROSTER_UUIDS`, filtered by `tenant_id` OR `user_id` — for normal traffic the
attribution key is **`tenant_id`**, which carries the user UUID; `user_id` is null on
non-BYOK calls). Pure metric logic lives in `supabase/functions/_shared/monitor/*`
(roster, pricing, health, quality, cost, alerts) with deno tests. All admin-gated:

- `GET /api/admin/monitor/overview` — per-user activity + dormant flags + completion-health matrix (attempts/success/failed/stuck/p50/p95).
- `GET /api/admin/monitor/activity?limit=` — recent `usage_events` feed (incl. query text; our DB only).
- `GET /api/admin/monitor/quality` — always-on brief fallback rate.
- `GET /api/admin/monitor/quality/run/:id` — per-search drill-down: relevance (top/mean cosine, off-ratio, below-floor) + duplicate pairs.
- `GET /api/admin/monitor/quality/paper/:id` — per-paper prose issues (bullets/headers/scratchpad/ref-dumps).
- `GET /api/admin/monitor/cost` — spend by user/action/model + budget burn-down vs `PROVIDER_BUDGET_GEMINI_USD`/`PROVIDER_BUDGET_CLAUDE_USD` (providers expose no live balance, so it's spend-vs-configured-number).
- `GET /api/admin/monitor/alerts` — currently-firing conditions (failure rate, fallback spike, stuck jobs, budget %).
- `POST /api/admin/monitor/judge/:paperId` — on-demand LLM JEL quality spot-check (self-hosted Qwen, gated background, persisted to `jel_paper_reviews`); `GET` the same path returns the cached review (no spend).

**`GET /api/monitor-alerts`** — the ONLY monitor route that is NOT admin-JWT-gated. Cron-only,
authenticated by header `x-monitor-secret` == env `MONITOR_CRON_SECRET`; returns only the alert
list (no PII). Handled pre-auth (like `_health`) so the 5-min GitHub Actions cron
(`.github/workflows/pilot-monitor-alerts.yml` → Slack) needs no expiring login token.
Frontend: the admin-only **Pilot Monitor** tab (`components/PilotMonitor.tsx`). CLI:
`scripts/pilot-monitor.mjs` (`--watch`/`--alerts`/`--judge`).

## Paper plans (Paper Studio)

- `POST /api/paper-plans` — create a draft plan from a search run. Body: `{ searchRunId, briefId? }`. Seeds `plan.curatedWorkIds` from the run's `evidence_work_ids`, `status='planning'`. Returns the `JelPaper` (with `plan`).
- `GET /api/paper-plans/:id` — fetch a plan (tenant-scoped).
- `PATCH /api/paper-plans/:id` — body `{ plan: <partial> }`, shallow-merged into the stored plan.
- `POST /api/paper-plans/:id/clarify` — runs the clarification engine over the plan's
  curated evidence. Returns `{ clarifyingQuestions[], alwaysAsk{audience,lengthOptions},
  workingQuestion, draftOutline, degraded }`. Gemini primary, Qwen fallback; on LLM failure
  returns the `degraded:true` "use query as-is" shape (still 200). Persists `draftOutline`
  into `plan.outlinePreview` when present; does NOT overwrite `workingQuestion` (client accepts via PATCH).
- `POST /api/paper-plans/:id/outline-preview` — regenerates the live outline from the
  current plan (workingQuestion + scope + emphasis + curated evidence). Returns
  `{ outlinePreview, degraded }` and persists `outlinePreview`. Cheap; re-runnable on every edit.
- `POST /api/jel-papers { planId }` — generate a survey FROM a plan (alternative to the
  legacy `{ searchRunId }` body). Requires the plan row to be `status='planning'` with
  curated evidence; reuses the SAME `jel_papers` row (`planning → queued → running → done`).
  Uses `plan.workingQuestion` as the outline north-star, `curatedWorkIds` minus
  `removedWorkIds` as evidence, and `plan.emphasis`/`scope` to shape the outline + sections.
  Returns the `JelPaper` (202). 409 if the plan is not in `planning`; 400 if it has no curated evidence.
- `POST /api/paper-plans/:id/uploads` — resolve an upload (`{ doiOrUrl }` or `{ pastedText }`)
  into a preview card `{ upload(PaperPlanUpload), inCorpus, kind }`. DOI → OpenAlex→Crossref→
  Semantic Scholar; paste → Qwen extraction; both → Qwen SMS classify + corpus match. With
  `confirm:true` (+ optional `uploadId` from the preview) it attaches to `plan.uploads` (dedup
  by uploadId, max 10 net-new → 409) and writes a `paper_upload_signals` row (`add_existing` if
  matched, else `add_new`); returns 201. Preview-only otherwise (nothing persisted). **Golden
  rule:** never upserts `works`.
- `POST /api/paper-plans/:id/expand-evidence` — body `{ planner: 'gemini'|'qwen', cap?: number }`.
  Grounded creative-planner evidence expansion (2026-06-12): the LLM proposes sub-queries + named
  works + sub-literatures, every proposal is grounded against the corpus via `searchLocalCorpus` and
  named works verified against stored authors/title/year, then `selectAdds` drops + caps. Returns
  `{ planner, model, query, added: PlannerAddedPaper[], dropped: PlannerDroppedProposal[], plan }`.
  **READ-ONLY / Golden rule:** never calls `retrieveWorks`, never writes `works` (only a `works.select`
  title lookup). The client decides which `added` ids to merge into `plan.curatedWorkIds`. See
  `_shared/creativePlanner.ts` + spec `docs/superpowers/specs/2026-06-12-creative-planner-paper-build-design.md`.
- `GET /api/paper-uploads` — this tenant's uploaded papers (≤50, most-recent, deduped by doi/title)
  for the Library "My uploaded papers" list + reuse.
- `POST /api/jel-papers/:id/revise { instruction }` — talk-to-the-draft. Routes the
  instruction (LLM) to the section(s) it targets and re-drafts only those (reusing the
  section pipeline + the plan's emphasis), then rebuilds the bibliography. Background job
  (status `done → running → done`). Capped at 2 per paper via `regenerations_used` (409 at
  the cap; 409 if not `done`; 400 if no instruction). The counter increments only on success;
  a failed revision reverts to `done` without consuming budget.
