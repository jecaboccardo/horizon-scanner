CREATE TABLE IF NOT EXISTS public.works (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  canonical_doi TEXT,
  year INTEGER,
  abstract TEXT,
  citation_count INTEGER DEFAULT 0,
  authors JSONB DEFAULT '[]'::jsonb,
  publication_date TEXT,
  is_open_access BOOLEAN DEFAULT false,
  open_access_pdf_url TEXT,
  fields_of_study JSONB DEFAULT '[]'::jsonb,
  url TEXT,
  source TEXT NOT NULL,
  raw_data JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_works_doi ON public.works (canonical_doi) WHERE canonical_doi IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_works_title_year ON public.works (lower(title), year);

ALTER TABLE public.works ENABLE ROW LEVEL SECURITY;
CREATE POLICY "works_select_authenticated" ON public.works FOR SELECT TO authenticated USING (true);
CREATE POLICY "works_insert_authenticated" ON public.works FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "works_update_authenticated" ON public.works FOR UPDATE TO authenticated USING (true);
CREATE POLICY "works_service_all" ON public.works FOR ALL TO service_role USING (true);
