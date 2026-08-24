-- 20260505000003_relax_intervention_outcome.sql
-- Make `intervention` and `outcome` nullable in evidence_cards.
--
-- Rationale: the extractor's HARD RULE #1 is grounding — if a paper has no
-- identifiable intervention (e.g., software documentation, R manuals, narrative
-- reviews, descriptive cross-sectional surveys), the extractor correctly returns
-- null rather than inventing one. The original NOT NULL constraint blocked these
-- papers from being recorded at all, leaving them stuck in `state=failed` after
-- 3 retries.
--
-- Smoke test caught this: of 10 high-priority papers (PRISMA, R manuals,
-- bioinformatics tools, Lancet descriptive), 5 failed solely on this constraint.
--
-- The signal that a card is weak is now carried by `confidence='low'` +
-- `needs_review=true`, which is more accurate than a hard schema rejection.
-- `source_text` and `finding_short` remain NOT NULL — those ARE grounding
-- fundamentals and a card without them is not a card.

alter table evidence_cards alter column intervention drop not null;
alter table evidence_cards alter column outcome drop not null;
