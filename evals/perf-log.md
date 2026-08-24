# Perf Log — Brief Generation Latency

Append-only log of brief-generation perf experiments. New entries at the bottom.

**Canonical test query:** `What does high-quality evidence say about AI and labor in Latin America?`
**Tenant:** `iadb-demo`
**Persona:** `jel` (default)
**Endpoint:** `POST /api/search-runs` → `GET /api/briefs/stream?searchRunId=…`

Run via: `node scripts/perf-bench-brief.mjs "<query>"` (creates run + times stream, prints summary).

---

## Categories of changes tested

- **synthesis** — Gemini token budgets, prompt length, persona settings.
- **retrieval** — Vector search params, HyDE, cross-encoder, filter funnel.
- **streaming** — SSE event emission, frontend wire-up.
- **infra** — Caching, connection warm-up, DB query optimization.

---

## Log entries

### 2026-05-11 — Baseline (v41 effectively in prod, deploy stale)
- **Build:** `v41-2026-05-08-per-facet-similarity-classifier` (prod actual, despite v42+v43 commits to main)
- **Category:** baseline
- **Hypothesis:** Establish current end-to-end latency for the canonical query before any perf work.
- **Two runs, canonical query "What does high-quality evidence say about AI and labor in Latin America?":**

  | Run | Total | search-runs POST | stream | phase1 → done | Gemini chunks |
  |---|---|---|---|---|---|
  | 1 | **88.91s** | 72.10s | 16.65s | 50ms | 0 |
  | 2 | **77.61s** | 61.81s | 15.65s | 60ms | 0 |

- **Surprise finding:** Gemini synthesis is NOT the bottleneck. The dominant cost is `/api/search-runs` POST (60–72s = retrieval: vector + HyDE + per-facet sim + filters). Stream emits phase1 + done within 50ms with 0 Gemini chunks — synthesis is either cached, short-circuited, or generated inside search-runs and returned wholesale.
- **Implication:** the v43 maxOutputTokens work (synthesis output-tokens) is barely on the critical path. **Perf work must pivot to the retrieval pipeline.**

### 2026-05-11 — Drop Gemini maxOutputTokens 16384 → 8192 (DEPLOYED, no impact)
- **Build:** `v43-2026-05-11-synthesis-maxoutput-8192` (commit `16b828d`) — confirmed live on `horizon-api.nextminder.com`
- **Category:** synthesis
- **Result:** Run on healthy v43 endpoint: total 83.70s = 68.17s + 15.39s. Stream time essentially unchanged vs v41 (15.65–16.65s). maxOutputTokens isn't on critical path because output isn't long enough to hit the old ceiling.
- **Decision:** keep the change (cleaner defaults, smaller risk window) but stop expecting savings here.

### 2026-05-11 — HyDE OFF — Test B (huge finding)
- **Build:** `v43-2026-05-11-synthesis-maxoutput-8192`
- **Category:** retrieval
- **Hypothesis:** HyDE channel does a Qwen generation + extra vector search; may be expensive relative to value added.
- **Override:** `{"hyde": false}` via body
- **Result:** Total **59.51s** (−24.2s) = search-runs 43.15s (−25.0s) + stream 16.23s. Same 488 candidates as baseline. **HyDE cost ~25s for zero new candidates on this query.**
- **Decision needed:** turn HyDE off by default for this query class? Or make HyDE conditional on first-pass returning <N candidates? Need eval-harness re-run on the gold queries before flipping globally.

### 2026-05-11 — HyDE OFF + CE ON — Test D (CE essentially free)
- **Build:** `v43-2026-05-11-synthesis-maxoutput-8192`
- **Category:** retrieval
- **Override:** `{"hyde": false, "crossEncoder": true, "crossEncoderTopN": 50}`
- **Result:** Total **55.62s** = search-runs 42.15s + stream 13.37s. Same 488 candidates. CE adds 0s (within noise) — either fast or didn't actually fire (worth verifying server logs).
- **Implication:** turning on cross-encoder is cheap. The remaining 42s in search-runs without HyDE is the next mystery. Prime suspect: per-facet semantic similarity (env flag `ENABLE_FACET_RETRIEVAL=true`, no per-request override).

---

## Next experiments queued

1. **Add per-request override for facet retrieval** — `{"facetRetrieval": false}` so we can isolate that cost.
2. **Instrument `retrieveWorks` with phase timings** — log start, post-HyDE, post-vector, post-facet, post-CE, post-filter durations. Without this we're guessing.
3. ~~**Eval-harness re-run with HyDE off**~~ ✅ done — confirmed zero quality loss on q01/q03, q02 was already broken regardless of HyDE.
4. **Investigate q02 canon regression** — Bhalotra/Anderberg/Aizer 0/3 in both modes. Was a working canon recovery 2 days ago per `project_hyde_pipeline_2026_05_09.md`. Something changed — probably the four-bucket classifier got stricter (`excludedByFacets=99` on q02). Separate from latency work.

### 2026-05-11 — HyDE off by default (shipped, v44)
- **Build:** `v44-2026-05-11-hyde-off-by-default` (commit `1a6ac95`)
- **Category:** retrieval
- **Change:** Flipped `hydeClient.ts` so HyDE requires explicit `ENABLE_HYDE=true` or `body.hyde=true` to fire. Per-request override still available for testing.
- **Result on canonical query (AI + labor + LAC):** total **63.72s** (search-runs 47.33s + stream 16.27s) — **−20s vs v43 baseline** (83.70s). 24% latency reduction. Candidate count unchanged at 488.
- **Status:** live on `horizon-api.nextminder.com`, BUILD_MARKER confirmed.

### 2026-05-11 — Facet retrieval override added (v45) + isolated cost
- **Build:** `v45-2026-05-11-facet-retrieval-override` (commit `9e47d2d`)
- **Category:** retrieval (instrumentation)
- **Change:** Added `{facetRetrieval: false}` per-request body override. Threads through `retrieveWorks → ENABLE_FACETS_RETRIEVAL`. When disabled, skips `decomposeQuery` (Qwen call) + multi-facet cosine + classification, falls back to single-vector `searchLocalCorpus`.
- **Result on canonical query, `{facetRetrieval: false}` (HyDE already off):** total **56.07s** (search-runs 40.80s + stream 15.15s) — **−6.5s vs v44 default**. Candidate count unchanged at 488.
- **Decision:** keep facet retrieval ON by default — disabling loses the four-bucket direct/indirect classification (visible in UI as match chips + coverage card counts). 6.5s isn't worth the feature loss. But override is available for cases where speed matters more than classification.

## Cumulative latency progress

| Stage | Total | search-runs | Δ |
|---|---|---|---|
| v41 baseline (today's start) | 77–89s | 60–72s | — |
| v44 (HyDE off) | 63.7s | 47.3s | **−20s** |
| v45 (HyDE off + facets off via override) | 56.1s | 40.8s | −7s |

**Shipped wins on default code path: ~−20s (24% faster).** The override gives another ~7s if needed.

## Remaining ~40s in retrieval — next step is instrumentation

With facets off + HyDE off, retrieve_works is *just*: query expansion (Qwen) + single-vector cosine + fetchWorksByIds batches + filter funnel + DB persist. None of those should individually take 40s. Suspect: maybe `expandQuery` is slower than expected, or `fetchWorksByIds` is doing N round-trips for 488 candidates. **Next step is adding `console.time()` phase markers inside `retrieveWorks` to actually see where the time goes**, not more A/B tests.

### 2026-05-11 — Phase timings shipped (v47) — finally the data
- **Build:** `v47-2026-05-11-perf-in-response` (commit `db1081e`)
- **Category:** retrieval (instrumentation)
- **Change:** Added `[perf]` log markers + `perfLog` field in API response so bench can read timings directly without VPS log access.
- **Cold-cache result (canonical query, 1st post-restart bench):** total **45.9s**

  | Phase | dt | Notes |
  |---|---|---|
  | corpus+live+expansion | **29.9s** | decomposeQuery + multi-facet + expandQuery — biggest target |
  | journal-rankings | **7.9s** | Cache load stampede — 492 parallel calls all racing to load tables |
  | embed-on-retrieval | 4.1s | 486 papers — was supposed to be fire-and-forget; deno cache stale |
  | works-upsert | 3.7s | 492 rows |
  | (everything else) | 0.3s | |

- **Warm-cache result (canonical query, 2nd run):** total **31.5s** — −14s. journal-rankings dropped to 27ms once cache loaded.
- **Findings & actions:**
  1. **`lookupJournalRankings` has 8s cold-start tax** every deploy. Fix: warm the cache at deno-api startup (call `loadRankings()` once before serving requests).
  2. **My fire-and-forget embedding fix didn't take effect** — Deno serving stale module cache (same issue as verifier.ts earlier). DevOps needs to clear `~/.cache/deno/gen/` before `systemctl restart deno-api` in `deploy-horizon.sh`.
  3. **`decomposeQuery(query)` called twice** — once in corpus search path, once in classify step. Marker shows the second call is fast (probably cached internally), but still worth deduping.
  4. **Next instrumentation target:** sub-phases inside the 24s `corpus+live+expansion` block — split decomposeQuery / HyDE / multi-facet pgvector / expandQuery.

### 2026-05-11 — Sub-phase timings shipped (v49/v50) — found the actual bottleneck
- **Build:** `v50-2026-05-11-embed-vs-rpc-timings` (commit `1b12d0c`)
- **Category:** retrieval (instrumentation)
- **Change:** Sub-instrumented the `corpus+live+expansion` block. Now splits: decomposeQuery / hyde / corpus.singleVector / corpus.multiVector / expandQuery. Further split corpus.singleVector into embed (LiteLLM Qwen call) and rpc (`match_works` Postgres call).
- **Three runs of canonical query:**
  - Multi-vector path (qf.facets ≥ 2): `corpus.multiVector dt=21,711ms` for 3 facets, 500 papers
  - Single-vector path (qf.facets < 2, fallback): `corpus.singleVectorFallback dt=22,275ms` for 500 papers
  - Forced single-vector via `facetRetrieval=false`: **`corpus.singleVector dt=22,185ms embed=102ms rpc=22,083ms`**
- **🎯 SMOKING GUN:** The `match_works` Postgres RPC takes 22 seconds. Embedding via Qwen is 102ms. The 22s is *entirely inside Postgres*.
- **Other findings from sub-phases:**
  - `decomposeQuery` 8s when invoked (Qwen call to break query into facets) — and inconsistent: returned 1 facet on one run, 3 on another. The 1-facet run wastes the call entirely because we fall back to single-vector anyway.
  - `expandQuery` 1.1–1.5s (Gemini 4 variants). Fine.
  - `hyde` 1ms (correctly skipped).
- **Fire-and-forget embed-on-retrieval finally took effect** (Deno module cache cleared by some later deploy): `embed-on-retrieval (fire-and-forget kicked off) dt=3ms`. Save: ~4s.
- **Latest v50 measurement:** total **50.5s** = search-runs 32.2s + stream 15.9s + run-create overhead.

### Next moves
1. **Hand DevOps the match_works RPC slowdown.** Likely cause: pgvector HNSW index needs rebuild after recent backfills, OR `ANALYZE works` is overdue, OR `fts_vector` index missing. Single biggest single remaining lever. **If fixed: total drops from 50s → ~28s.**
2. **Skip decomposeQuery when it returns <2 facets**, because we fall back to single-vector anyway. Save 8s on those queries (~50%? need eval).
3. **Investigate q02 canon recall regression** (separate quality bug).

---
