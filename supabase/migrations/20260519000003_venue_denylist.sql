-- Permanent venue denylist for non-econ / out-of-scope sources.
--
-- Retrieval/import code filters these venues before user-visible results.
-- This table + trigger is the backstop: any future insert/update into works
-- with a denylisted venue is skipped so the corpus cannot re-accumulate them.

create or replace function public.normalize_venue_key(input text)
returns text
language sql
immutable
as $$
  select regexp_replace(
    replace(
      lower(
        translate(
          coalesce(input, ''),
          'áàäâãåéèëêíìïîóòöôõúùüûñçÁÀÄÂÃÅÉÈËÊÍÌÏÎÓÒÖÔÕÚÙÜÛÑÇ',
          'aaaaaaeeeeiiiiooooouuuuncAAAAAAEEEEIIIIOOOOOUUUUNC'
        )
      ),
      '&',
      'and'
    ),
    '[^a-z0-9]+',
    '',
    'g'
  );
$$;

create table if not exists public.venue_denylist (
  venue_name text primary key,
  venue_key text generated always as (public.normalize_venue_key(venue_name)) stored unique,
  active boolean not null default true,
  reason text not null default 'manual_out_of_scope_venue',
  created_at timestamptz not null default now()
);

insert into public.venue_denylist (venue_name, reason) values
  ('Academic Radiology', 'manual_out_of_scope_venue'),
  ('Acta odontológica latinoamericana', 'manual_out_of_scope_venue'),
  ('Acta Tropica', 'manual_out_of_scope_venue'),
  ('Advances in Atmospheric Sciences', 'manual_out_of_scope_venue'),
  ('Advances in kidney disease and health', 'manual_out_of_scope_venue'),
  ('Advances in Parasitology', 'manual_out_of_scope_venue'),
  ('Aesthetic Plastic Surgery', 'manual_out_of_scope_venue'),
  ('Animal Reproduction Science', 'manual_out_of_scope_venue'),
  ('Annals of Emergency Medicine', 'manual_out_of_scope_venue'),
  ('Annals of Hepatology', 'manual_out_of_scope_venue'),
  ('Annals of Oncology', 'manual_out_of_scope_venue'),
  ('Annals of Pharmacotherapy', 'manual_out_of_scope_venue'),
  ('Annals of Physics', 'manual_out_of_scope_venue'),
  ('Annals of the Rheumatic Diseases', 'manual_out_of_scope_venue'),
  ('Annals of Vascular Surgery', 'manual_out_of_scope_venue'),
  ('Anthropocene Science', 'manual_out_of_scope_venue'),
  ('Antiviral Research', 'manual_out_of_scope_venue'),
  ('Apidologie', 'manual_out_of_scope_venue'),
  ('Appetite', 'manual_out_of_scope_venue'),
  ('Applied Animal Behaviour Science', 'manual_out_of_scope_venue'),
  ('Applied Geochemistry', 'manual_out_of_scope_venue'),
  ('Applied Geomatics', 'manual_out_of_scope_venue'),
  ('Applied Nursing Research', 'manual_out_of_scope_venue'),
  ('Archives of gerontology and geriatrics', 'manual_out_of_scope_venue'),
  ('Archives of gerontology and geriatrics (Print)', 'manual_out_of_scope_venue'),
  ('Archives of Gynecology and Obstetrics', 'manual_out_of_scope_venue'),
  ('Archives of Iranian medicine', 'manual_out_of_scope_venue'),
  ('Archives of Medical Research', 'manual_out_of_scope_venue'),
  ('Archives of Osteoporosis', 'manual_out_of_scope_venue'),
  ('Archives of Physical Medicine and Rehabilitation', 'manual_out_of_scope_venue'),
  ('Archivos de Bronconeumologia', 'manual_out_of_scope_venue'),
  ('Asian Pacific Journal of Cancer Prevention', 'manual_out_of_scope_venue'),
  ('Atmospheric research', 'manual_out_of_scope_venue'),
  ('Autoimmunity Reviews', 'manual_out_of_scope_venue'),
  ('Berghahn Books', 'manual_out_of_scope_venue'),
  ('Best Practice & Research: Clinical Obstetrics & Gynaecology', 'manual_out_of_scope_venue'),
  ('Best practice & research. Clinical gastroenterology', 'manual_out_of_scope_venue'),
  ('BJOG: an International Journal of Obstetrics and Gynaecology', 'manual_out_of_scope_venue'),
  ('BMC Public Health', 'manual_out_of_scope_venue'),
  ('Bone Marrow Transplantation', 'manual_out_of_scope_venue'),
  ('Breast Cancer Research and Treatment', 'manual_out_of_scope_venue'),
  ('Burns', 'manual_out_of_scope_venue'),
  ('Canadian family physician Medecin de famille canadien', 'manual_out_of_scope_venue'),
  ('Canadian Journal of Cardiology', 'manual_out_of_scope_venue'),
  ('Canadian Journal of Surgery', 'manual_out_of_scope_venue'),
  ('Canadian oncology nursing journal = Revue canadienne de nursing oncologique', 'manual_out_of_scope_venue'),
  ('Cancer Causes and Control', 'manual_out_of_scope_venue'),
  ('Cancer Genetics', 'manual_out_of_scope_venue'),
  ('Cancer Research', 'manual_out_of_scope_venue'),
  ('Cancer Treatment Reviews', 'manual_out_of_scope_venue'),
  ('Cell stress & chaperones', 'manual_out_of_scope_venue'),
  ('Cell stress & chaperones (Print)', 'manual_out_of_scope_venue'),
  ('Cerebellum', 'manual_out_of_scope_venue'),
  ('Chapters in SUERF Studies', 'manual_out_of_scope_venue'),
  ('Chemosphere', 'manual_out_of_scope_venue'),
  ('Chest', 'manual_out_of_scope_venue'),
  ('Clinical Epidemiology of Chronic Liver Diseases', 'manual_out_of_scope_venue'),
  ('Clinical Lung Cancer', 'manual_out_of_scope_venue'),
  ('Clinical medicine (London)', 'manual_out_of_scope_venue'),
  ('Clinical Microbiology and Infection', 'manual_out_of_scope_venue'),
  ('Clinical Research in Cardiology', 'manual_out_of_scope_venue'),
  ('Clinical Rheumatology', 'manual_out_of_scope_venue'),
  ('Coastal Engineering', 'manual_out_of_scope_venue'),
  ('Current Hematologic Malignancy Reports', 'manual_out_of_scope_venue'),
  ('Current HIV/AIDS Reports', 'manual_out_of_scope_venue'),
  ('Current Infectious Disease Reports', 'manual_out_of_scope_venue'),
  ('Endocrine Practice', 'manual_out_of_scope_venue'),
  ('Enfermedades Infecciosas y Microbiologia Clinica', 'manual_out_of_scope_venue'),
  ('Experimental Gerontology', 'manual_out_of_scope_venue'),
  ('Eye', 'manual_out_of_scope_venue'),
  ('Gaceta Sanitaria', 'manual_out_of_scope_venue'),
  ('Haemophilia', 'manual_out_of_scope_venue'),
  ('Heart and Vessels', 'manual_out_of_scope_venue'),
  ('Heart, Lung and Circulation', 'manual_out_of_scope_venue'),
  ('Immunologic research', 'manual_out_of_scope_venue'),
  ('Indian Journal of Hematology and Blood Transfusion', 'manual_out_of_scope_venue'),
  ('Indian Journal of Small Ruminants', 'manual_out_of_scope_venue'),
  ('Infectious Disease Clinics of North America', 'manual_out_of_scope_venue'),
  ('Injury', 'manual_out_of_scope_venue'),
  ('Inquiry : a journal of medical care organization, provision and financing', 'manual_out_of_scope_venue'),
  ('Intensive Care Medicine', 'manual_out_of_scope_venue'),
  ('Internal and Emergency Medicine', 'manual_out_of_scope_venue'),
  ('International Journal of Antimicrobial Agents', 'manual_out_of_scope_venue'),
  ('International Journal of Cardiology', 'manual_out_of_scope_venue'),
  ('International Journal of Nursing Education', 'manual_out_of_scope_venue'),
  ('International Journal of Nursing Studies', 'manual_out_of_scope_venue'),
  ('International Journal of Obesity', 'manual_out_of_scope_venue'),
  ('International Journal of Oral & Maxillofacial Surgery', 'manual_out_of_scope_venue'),
  ('International Journal of Pediatric Otorhinolaryngology', 'manual_out_of_scope_venue'),
  ('ISPRS Journal of Photogrammetry and Remote Sensing', 'manual_out_of_scope_venue'),
  ('Joint, bone, spine : revue du rhumatisme', 'manual_out_of_scope_venue'),
  ('Jornal de Pediatria', 'manual_out_of_scope_venue'),
  ('Journal of Allergy and Clinical Immunology', 'manual_out_of_scope_venue'),
  ('Journal of Bodywork and Movement Therapies', 'manual_out_of_scope_venue'),
  ('Journal of Cancer Education', 'manual_out_of_scope_venue'),
  ('Journal of cancer survivorship', 'manual_out_of_scope_venue'),
  ('Journal of Cardiac Failure', 'manual_out_of_scope_venue'),
  ('Journal of Cardiovascular Translational Research', 'manual_out_of_scope_venue'),
  ('Journal of Clinical Epidemiology', 'manual_out_of_scope_venue'),
  ('Journal of Clinical Immunology', 'manual_out_of_scope_venue'),
  ('Journal of clinical sleep medicine : JCSM : official publication of the American Academy of Sleep Medicine', 'manual_out_of_scope_venue'),
  ('Journal of Clinical Outcomes Management', 'manual_out_of_scope_venue'),
  ('Journal of Clinical Virology', 'manual_out_of_scope_venue'),
  ('Journal of Cystic Fibrosis', 'manual_out_of_scope_venue'),
  ('Journal of Ethnopharmacology', 'manual_out_of_scope_venue'),
  ('Journal of Fluorescence', 'manual_out_of_scope_venue'),
  ('Journal of healthcare protection management : publication of the International Association for Hospital Security', 'manual_out_of_scope_venue'),
  ('Journal of Hepatology', 'manual_out_of_scope_venue'),
  ('Journal of Hydro-environment Research', 'manual_out_of_scope_venue'),
  ('Journal of Hydrology', 'manual_out_of_scope_venue'),
  ('Journal of medical systems', 'manual_out_of_scope_venue'),
  ('Journal of Modern Jewish Studies', 'manual_out_of_scope_venue'),
  ('Journal of Neuroimmunology', 'manual_out_of_scope_venue'),
  ('Journal of Neurological Sciences', 'manual_out_of_scope_venue'),
  ('Journal of Obstetric, Gynecologic and Neonatal Nursing', 'manual_out_of_scope_venue'),
  ('Journal of Obstetrics and Gynaecology Canada', 'manual_out_of_scope_venue'),
  ('Journal of Pain and Symptom Management', 'manual_out_of_scope_venue'),
  ('Journal of The Lepidopterists Society', 'manual_out_of_scope_venue'),
  ('Journal of the National Medical Association', 'manual_out_of_scope_venue'),
  ('Journal of the Pediatric Infectious Diseases Society', 'manual_out_of_scope_venue'),
  ('Journal of Thoracic Oncology', 'manual_out_of_scope_venue'),
  ('Journal of Trace Elements in Medicine and Biology', 'manual_out_of_scope_venue'),
  ('Kidney International', 'manual_out_of_scope_venue'),
  ('Lancet Infectious Diseases', 'manual_out_of_scope_venue'),
  ('Lancet Neurology', 'manual_out_of_scope_venue'),
  ('Lancet. Infectious Diseases (Print)', 'manual_out_of_scope_venue'),
  ('Lung Cancer', 'manual_out_of_scope_venue'),
  ('Nurse Education Today', 'manual_out_of_scope_venue'),
  ('Nursing Education Perspectives', 'manual_out_of_scope_venue'),
  ('Nursing History Review', 'manual_out_of_scope_venue'),
  ('Nursing Science Quarterly', 'manual_out_of_scope_venue'),
  ('Ophthalmology (Rochester, Minn.)', 'manual_out_of_scope_venue'),
  ('Osteoporosis International', 'manual_out_of_scope_venue'),
  ('Pain Physician', 'manual_out_of_scope_venue'),
  ('Palaeogeography, Palaeoclimatology, Palaeoecology', 'manual_out_of_scope_venue'),
  ('Pakistan Journal of Commerce and Social Sciences', 'manual_out_of_scope_venue'),
  ('Palliative Care and Social Practice', 'manual_out_of_scope_venue'),
  ('Patient Education and Counseling', 'manual_out_of_scope_venue'),
  ('Pediatric nephrology (Berlin, West)', 'manual_out_of_scope_venue'),
  ('Pediatric Radiology', 'manual_out_of_scope_venue'),
  ('Pediatric Research', 'manual_out_of_scope_venue'),
  ('Pediatric surgery international (Print)', 'manual_out_of_scope_venue'),
  ('Perioperative Care and Operating Room Management', 'manual_out_of_scope_venue'),
  ('PharmacoEconomics (Auckland)', 'manual_out_of_scope_venue'),
  ('Plant Ecology', 'manual_out_of_scope_venue'),
  ('Preventive Medicine', 'manual_out_of_scope_venue'),
  ('Preventive Veterinary Medicine', 'manual_out_of_scope_venue'),
  ('Proceedings of the Social and Humaniora Research Symposium (SoRes 2018)', 'manual_out_of_scope_venue'),
  ('Surgery', 'manual_out_of_scope_venue'),
  ('Surgical Endoscopy', 'manual_out_of_scope_venue'),
  ('Surveys in geophysics', 'manual_out_of_scope_venue'),
  ('World journal of urology', 'manual_out_of_scope_venue'),
  ('World Neurosurgery', 'manual_out_of_scope_venue')
on conflict (venue_key) do update
set active = true,
    reason = excluded.reason;

create or replace function public.skip_venue_denylist_works()
returns trigger
language plpgsql
as $$
begin
  if new.venue is not null and exists (
    select 1
    from public.venue_denylist d
    where d.active is true
      and d.venue_key = public.normalize_venue_key(new.venue)
  ) then
    if tg_op = 'INSERT' then
      return null;
    end if;
    return old;
  end if;

  return new;
end;
$$;

drop trigger if exists works_skip_venue_denylist on public.works;
create trigger works_skip_venue_denylist
before insert or update of venue on public.works
for each row execute function public.skip_venue_denylist_works();

alter table public.venue_denylist enable row level security;

drop policy if exists "service_role_all" on public.venue_denylist;
create policy "service_role_all" on public.venue_denylist
  for all using (auth.role() = 'service_role');

drop policy if exists "authenticated_read" on public.venue_denylist;
create policy "authenticated_read" on public.venue_denylist
  for select using (auth.role() = 'authenticated');

comment on table public.venue_denylist is
  'Manual venue denylist for out-of-scope sources. works inserts/updates matching active normalized venue keys are skipped by trigger.';
