-- 20260615000001_cosine_for_ids.sql
-- Real query·paper cosine for an explicit set of ids. Lets the unified reranker
-- give channel-surfaced papers (foundational-SQL / topic-geo, which arrive with a
-- SYNTHETIC placeholder similarity) a TRUE relevance score. Read-only on works.embedding.
--
-- Self-hosted Supabase: pgvector lives in the `extensions` schema, so the param
-- type is extensions.vector(768) and the function SETs search_path = extensions,
-- public (else `<=>` fails with "operator does not exist: extensions.vector <=> ...").
create or replace function cosine_for_ids(p_query extensions.vector(768), p_ids text[])
returns table(id text, cosine double precision)
language sql stable
set search_path = extensions, public
as $$
  select w.id, 1 - (w.embedding <=> p_query) as cosine
  from works w
  where w.id = any(p_ids) and w.embedding is not null
$$;
grant execute on function cosine_for_ids(extensions.vector(768), text[]) to service_role, anon, authenticated;
