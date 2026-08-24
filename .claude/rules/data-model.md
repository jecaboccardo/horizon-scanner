# Data Model

All types defined in `types.ts`. This file explains the relationships and semantics.

## Core Entities

### SourceRecord
Where evidence comes from. Each source has a credibility tier and use policy.

- `sourceType`: institutional | journal | repository | social | manual
- `credibilityTier`: Tier A (best) | Tier B | Tier C (signals only)
- `allowedUse`: evidence | signal | restricted — admin-mutable via source review
- `coverageType`: scholarly | gray-literature | signal

### Work
A single research paper, report, or signal. Central entity that everything links to.

- Belongs to one `SourceRecord` via `sourceId`
- Has one `MethodologyTag` (embedded) with design, causal strength, confidence signals, limitations
- `qualityTier`: inherited from source at ingest time
- `lacRelevance`: 0–1 score for Latin America/Caribbean relevance
- `chunks`: `EvidenceChunk[]` — sectioned text (abstract, methods, results, limitations)
- `versions`: `WorkVersion[]` — publication history

### SearchRun
A single query + filter execution. Captures the full retrieval pipeline output.

- `intent`: expanded query (entities, synonyms, geography, timeframe)
- `candidateWorkIds`: all works that scored > 0
- `evidenceWorkIds`: subset passing tier + policy filters
- `signalWorkIds`: subset with `allowedUse=signal` (only if `includeSignals=true`)
- `coverage`: funnel metrics (universe → retrieved → admissible → evidence → signal)

### EvidenceBrief
The output product — a structured 5-section brief generated from a SearchRun.

- `sections`: `EvidenceBriefSections` — the 5 fixed sections + citations + warnings
- `auditTrace`: model, prompt versions, retrieval policy, generation notes
- `status`: draft | ready | error

### Supporting Entities
- `AlertSubscription` — topic/author/search watches with daily/weekly cadence
- `FeedItem` — activity feed (paper, brief, signal events)
- `FeedbackEvent` — user ratings (like, dislike, save, dismiss) on briefs or works

## Enums and Badges

| Type | Values |
|------|--------|
| `SourceCredibilityTier` | Tier A, Tier B, Tier C |
| `AllowedUse` | evidence, signal, restricted |
| `MethodologyDesign` | RCT, DiD, IV, RDD, Observational, Simulation, Qualitative, Mixed Methods |
| `CausalStrength` | high, moderate, limited, signal |
| `BriefStatus` | draft, ready, error |
| `FeedbackRating` | like, dislike, save, dismiss |
| `FeedItemKind` | paper, brief, signal |

## SearchFilters Shape

**Source of truth: the `SearchFilters` interface in `types.ts` (currently lines 191-227).**
Do not re-transcribe the full shape here — read the interface. The fields below are only the
ones with non-obvious *semantics* (defaults / server behaviour) that the type alone doesn't convey:

```typescript
// topics            // default [] (was ['AI','Labor'] — removed: polluted intent expansion)
// regions           // hard region filter; LAC keyword list synced rerank.ts↔retrieval.ts (check:invariants)
// timePeriod/startDate/endDate  // startDate '' unless timePeriod==='custom'
// allSources        // boolean — true bypasses the source universe
// smsLevels         // [] = all rigor levels (no filter)
// channels?         // VALID_CHANNEL_IDS = causal|foundational|recent|lac; sent as channelsOverride, validated server-side
// publicationTypes? // document-type filter; UI selects PUBLICATION_TYPE_GROUPS, stores unioned flat values; []/undefined = all
// journalTiers? / excludedJournalsByTier? / workingPaperSources? / institutionalSources?  // source universe; WP undefined=server default, []=exclude all
// evidenceMatch?    // 'direct'|'both'|'all'; ABSENT === 'both' (server default — old runs must NOT skip the classifier filter)
// absRatings / repecBands  // deprecated, kept for legacy saved runs (not used in retrieval)
```

> NOTE: `retrieval.ts` has a *hand-copied* `SearchFilters` mirror (it can't import the frontend
> type across the Deno/TSX boundary). Field names are the load-bearing contract — `check:invariants`
> asserts the two key-sets match, so adding a field to one side without the other fails CI.

## State Management

All runtime state is persisted in **Postgres** (self-hosted Supabase on the VPS). The Deno API is stateless — it reads and writes to the DB on every request. There is no in-memory store; a server restart loses nothing. See CLAUDE.md → Database access for the connection model (Kong/PostgREST for CRUD, direct Postgres for DDL migrations).
