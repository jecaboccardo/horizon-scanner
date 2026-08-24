-- 2026-05-13 — Indexes to support SQL pre-filtering in match_works.
--
-- Today match_works runs the vector ANN/seq scan over the full 622k-row
-- universe, then filters happen in TypeScript after the fact. This means the
-- recall ceiling is whatever HNSW returns from the full corpus — which is
-- 0.016% on the dense academic embedding distribution.
--
-- The fix is to pre-filter inside the SQL (year, venue, sms_level soft,
-- topics, regions, publication_type) so the vector match runs over a much
-- smaller universe and recall is whatever the smaller scan returns.
--
-- This migration adds the missing indexes those predicates will use. The
-- match_works function signature change is in a follow-up migration so this
-- one is purely additive and safe to run anytime.
--
-- All indexes use CONCURRENTLY — single-column btree on small data, NOT the
-- HNSW disaster from 2026-05-11. Safe under live traffic.

-- year is 100% populated. Used for the "2010 onwards" default.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_works_year
  ON works (year)
  WHERE year IS NOT NULL;

-- abs_rating is 31% populated. Used when users restrict to ABS 3/4/4*.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_works_abs_rating
  ON works (abs_rating)
  WHERE abs_rating IS NOT NULL;

-- repec_percentile is 37% populated. Used for top-X% RePEc filtering.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_works_repec_percentile
  ON works (repec_percentile)
  WHERE repec_percentile IS NOT NULL;

-- pg_trgm enables fast ILIKE on venue for institutional+WP patterns
-- (IADB, World Bank, NBER, SSRN, IZA, ...). The existing idx_works_venue
-- btree handles exact tier-1/2 journal matches; this trgm GIN handles
-- the substring patterns.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_works_venue_trgm
  ON works USING gin (venue gin_trgm_ops)
  WHERE venue IS NOT NULL;

ANALYZE works;
