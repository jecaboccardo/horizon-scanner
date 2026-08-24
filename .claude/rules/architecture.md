# Architecture - Retrieval-Augmented Synthesis Pipeline

## Data Flow

```text
User query + filters
  -> planSearchIntent
  -> retrieveWorks
  -> searchLocalCorpus / match_works_v2
  -> ranked candidates + evidence cards when available
  -> createBriefFromRun or createStreamingBriefFromRun
  -> deterministic brief plus optional Gemini synthesis
```

## Production Runtime

The active backend is the self-hosted Deno runtime:

- `server-deno/server.ts` starts `Deno.serve()` on `DENO_API_PORT` (default
  `3002`).
- `supabase/functions/api/index.ts` owns all route handlers.
- Shared retrieval, synthesis, LLM, auth, and verifier code lives in
  `supabase/functions/_shared/`.
- The frontend uses Vite on port `3000` and proxies `/api` to Deno on `3002`.

## Retrieval Stack

`retrieveWorks()` in `supabase/functions/_shared/retrieval.ts` combines:

- Query planning and synonym/entity expansion
- Hybrid vector + FTS retrieval through `match_works_v2`
- User-selected time, source, publication type, region, and SMS filters
- Evidence/directness classification
- Composite rerank over the relevance-qualified pool (`rerank.ts`).
  **Source of truth: `DEFAULT_RERANK_WEIGHTS` + per-channel `CHANNEL_RERANK_WEIGHTS`
  in `supabase/functions/_shared/rerank.ts`. Do NOT quote weight values in docs —
  read the constants** (the old single Phase-1.3 weight set is superseded by
  BO-optimised per-channel weights). When multiple channels are active,
  `rerankInterleaved()` ranks the pool once per channel with that channel's weights
  and round-robins (avoids the "averaged weights" problem). Foundational carries a
  pre-2020 age preference; a P0 citation gate damps topically-weak high-citation
  papers (so off-topic mega-cited papers don't ride citation into the top).
  App.tsx `channelsToRerankWeights` mirrors the per-channel weights for single-channel
  overrides — kept in sync by `scripts/check-invariants.mjs`. Per-paper
  channel-of-origin is persisted (`work_channels` jsonb on `search_runs`) for the
  evidence-table pills + JEL "Evidence provenance".

Do not reintroduce invisible venue hard filters as defaults. User-selected
source filters may become hard SQL prefilters; default quality should be a
ranking signal unless the user opts into a filter.

## Synthesis Stack

`createBriefFromRun()` and `createStreamingBriefFromRun()` in
`supabase/functions/_shared/synthesis.ts` produce the fixed brief structure.
Deterministic synthesis always runs; Gemini can refine text but must not invent
evidence rows or citations.

## Frontend Architecture

Single-page app in `App.tsx`:

- `search` for evidence briefs
- `library` for saved work
- `follow` for alerts/feed
- `notes` for workspace notes
- `admin` for review tools
- `pilot-monitor` for SCL pilot observability (admin-only; usage/health/quality/cost + Slack alerts — see api-contracts.md → Monitoring)

`services/apiClient.ts` owns HTTP calls. Components stay presentational where
possible.
