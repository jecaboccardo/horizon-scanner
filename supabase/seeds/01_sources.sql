-- Seed: real academic and institutional sources for Horizon Scanner
-- Tier assignments match types.ts SourceCredibilityTier: 'Tier A' | 'Tier B' | 'Tier C'
-- ON CONFLICT guards prevent duplicate inserts on re-seed
--
-- Tier A: Top-tier peer-reviewed institutional sources (high methodological standards)
-- Tier B: Quality gray literature and curated policy outlets
-- Tier C: Signal sources (social, emerging discourse — not admissible as evidence)

INSERT INTO public.sources (name, source_type, credibility_tier, coverage_type, license_access, allowed_use, homepage)
VALUES
  (
    'NBER',
    'repository',
    'Tier A',
    'scholarly',
    'open',
    'evidence',
    'https://www.nber.org'
  ),
  (
    'SSRN',
    'repository',
    'Tier B',
    'scholarly',
    'open',
    'evidence',
    'https://www.ssrn.com'
  ),
  (
    'World Bank',
    'institutional',
    'Tier A',
    'scholarly',
    'open',
    'evidence',
    'https://www.worldbank.org'
  ),
  (
    'IZA',
    'repository',
    'Tier A',
    'scholarly',
    'open',
    'evidence',
    'https://www.iza.org'
  ),
  (
    'CEPAL',
    'institutional',
    'Tier A',
    'scholarly',
    'open',
    'evidence',
    'https://www.cepal.org'
  ),
  (
    'J-PAL',
    'institutional',
    'Tier A',
    'scholarly',
    'open',
    'evidence',
    'https://www.povertyactionlab.org'
  ),
  (
    'Brookings',
    'institutional',
    'Tier B',
    'gray-literature',
    'open',
    'evidence',
    'https://www.brookings.edu'
  ),
  (
    '3ie',
    'institutional',
    'Tier A',
    'scholarly',
    'open',
    'evidence',
    'https://3ieimpact.org'
  ),
  (
    'IADB Publications',
    'institutional',
    'Tier A',
    'scholarly',
    'open',
    'evidence',
    'https://publications.iadb.org'
  ),
  (
    'VoxDev',
    'journal',
    'Tier B',
    'gray-literature',
    'open',
    'evidence',
    'https://voxdev.org'
  )
ON CONFLICT (name) DO NOTHING;
