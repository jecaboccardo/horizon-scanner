---
name: corpus-gap-count
description: Get current corpus metadata-gap counts (null abstracts, SMS, citations, geography, embeddings). Use whenever you need to know how complete the corpus is, before/after a backfill, or when planning backfill work. NEVER quote a hardcoded gap table — always run this.
---

# Corpus gap count

The corpus gap numbers change constantly (backfills run, search ingests new papers).
**Never trust a hardcoded table in docs or memory** — run the counter.

## Run it

```bash
node scripts/count-corpus-gaps.mjs
```

Reads `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` from `.env` (Kong gateway).
Writes `reports/corpus-gap-counts.json` and prints a JSON block:

- `total_canonical_non_noise` — the denominator (canonical, `is_noise` not true)
- `null_abstract_total` / `null_abstract_has_doi`
- `null_embedding_total` / `has_abstract_null_embedding` (re-embeddable)
- `null_citation_count`
- `null_sms_level` / `null_sms_has_abstract` (only the ones with an abstract are classifiable)
- `null_geography`

## Interpreting

- **`null_sms_has_abstract`** (not `null_sms_level`) is the real SMS-backfill target —
  papers without an abstract can't be reliably classified.
- **`null_abstract_has_doi`** is the reachable-by-DOI abstract gap; the rest are pre-DOI.
- A sudden jump in any gap after a search session can signal a hot-path clobber —
  cross-check the **golden rule** (`feedback_retrieval_never_clobbers_curated_data`).

Cheap, read-only, safe to run anytime (including while prod is live).
