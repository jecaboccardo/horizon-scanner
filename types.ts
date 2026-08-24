export type SourceCredibilityTier = 'Tier A' | 'Tier B' | 'Tier C';
export type AllowedUse = 'evidence' | 'signal' | 'restricted';
export type MethodologyDesign =
  | 'RCT'
  | 'DiD'
  | 'IV'
  | 'RDD'
  | 'Observational'
  | 'Simulation'
  | 'Qualitative'
  | 'Mixed Methods';
export type CausalStrength = 'high' | 'moderate' | 'limited' | 'signal';
export type BriefStatus = 'draft' | 'ready' | 'error';
export type FeedbackRating = 'like' | 'dislike' | 'save' | 'dismiss';
export type SearchPurpose = 'brief' | 'litreview' | 'scan';
export type FeedItemKind = 'paper' | 'brief' | 'signal';
export type PublicationType =
  | 'journal_article'
  | 'working_paper'
  | 'discussion_paper'
  | 'report'
  | 'book'
  | 'book_chapter'
  | 'conference_paper'
  | 'preprint'
  | 'dataset'
  | 'dissertation'
  | 'other';
// POLICY-ONLY (2026-06-03): `policy` is the SOLE active brief register. The
// brief persona picker / persona-swap UI was removed; every new brief is a
// policy brief. `technical` (and all the other personas) are RETIRED — kept in
// the PersonaId union ONLY so briefs persisted with older values still
// type-check on read and render. NOTE: this `AudienceId` is the BRIEF register;
// it is independent of `PaperPlanEmphasis.audience` (its own `'policy' |
// 'technical'` literal union below), which the JEL paper / Paper Studio pins to
// 'technical' and is NOT affected by this change.
export type AudienceId = 'policy';
export type RetiredPersonaId = 'technical' | 'research' | 'non-technical' | 'country-economist' | 'sector-expert' | 'operations' | 'jel' | 'twitter' | 'talking-points';
export type LegacyPersonaId = RetiredPersonaId; // backwards compat alias
export type PersonaId = AudienceId | RetiredPersonaId;
export const AUDIENCE_IDS: AudienceId[] = ['policy'];
export const PERSONA_IDS: PersonaId[] = [...AUDIENCE_IDS, 'technical', 'research', 'non-technical', 'country-economist', 'sector-expert', 'operations', 'jel', 'twitter', 'talking-points'];
// The summary brief defaults to the IADB Policy Brief register (see CLAUDE.md
// "Search UX flow"). Keep in sync with DEFAULT_PERSONA in
// supabase/functions/_shared/prompts.ts (the server copy — cross-runtime files
// can't share an import). The JEL survey paper / Paper Studio pins its own
// emphasis.audience='technical' and does NOT read this constant.
export const DEFAULT_PERSONA: PersonaId = 'policy';

export interface ThreadTweet {
  text: string;
  role: 'hook' | 'context' | 'finding' | 'method' | 'mechanism' | 'caveat' | 'so-what';
}

export interface SourceRecord {
  id: string;
  name: string;
  sourceType: 'institutional' | 'journal' | 'repository' | 'social' | 'manual';
  credibilityTier: SourceCredibilityTier;
  coverageType: 'scholarly' | 'gray-literature' | 'signal';
  licenseAccess: 'open' | 'restricted' | 'unknown';
  allowedUse: AllowedUse;
  homepage: string;
}

export interface MethodologyTag {
  design: MethodologyDesign;
  causalStrength: CausalStrength;
  sample?: string;
  geography?: string;
  interventionType?: string;
  outcomes?: string[];
  confidenceSignals: string[];
  limitations: string[];
}

export interface WorkVersion {
  id: string;
  label: string;
  publishedAt: string;
  url: string;
}

export interface EvidenceChunk {
  id: string;
  workId: string;
  section: 'abstract' | 'methods' | 'results' | 'limitations';
  text: string;
}

export interface Work {
  id: string;
  title: string;
  canonicalDoi?: string;
  sourceId: string;
  sourceType: SourceRecord['sourceType'];
  qualityTier: SourceCredibilityTier;
  geography: string[];
  topics: string[];
  year: number;
  institution: string;
  authors: string[];
  methodology: MethodologyTag;
  interventionType: string;
  abstract: string;
  summary: string;
  url: string;
  citationCount: number;
  lacRelevance: number;
  versions: WorkVersion[];
  chunks: EvidenceChunk[];
  source?: string;
  openAccessPdfUrl?: string | null;
  venue?: string | null;
  smsLevel?: number | null;
  methodologyDesign?: string | null;
  causalStrength?: string | null;
  absRating?: string | null;
  repecRank?: number | null;
  repecPercentile?: number | null;
  publicationType?: PublicationType | null;
  publicationTypeMethod?: string | null;
  publicationTypeConfidence?: number | null;
  sourceFamily?: string | null;
  venueKind?: string | null;
  excluded?: boolean;
  starred?: boolean;
  smsRationale?: string | null;
  abstractBackfill?: {
    source?: string | null;
    status?: string | null;
    provenance_note?: string | null;
    jstor_url?: string | null;
    model?: string | null;
  } | null;
  journalMatchInfo?: {
    matchType: 'exact' | 'normalized';
    inputVenue: string;
    normalizedKey: string;
    absField?: string | null;
    repecTotalCount?: number | null;
  } | null;
}

export type RepecBand = 'top_5' | 'top_5_10' | 'top_10_25' | 'top_25_50' | 'bottom_50';

// ── Retrieval channels (Q1 of the search-intent card) ───────────────────────
// The four evidence channels the search-intent card exposes. Sent to the server
// as `SearchFilters.channels` / the top-level `channels` override on
// POST /api/search-runs (see services/apiClient.ts → createSearchRun). Keep in
// sync with the server copy in supabase/functions/_shared/retrieval.ts
// (cross-runtime files can't share an import).
export const VALID_CHANNEL_IDS = ['causal', 'foundational', 'recent', 'lac'] as const;
export type ChannelId = typeof VALID_CHANNEL_IDS[number];

// ── Document-type filter (2026-06-03) ───────────────────────────────────────
// UI groups → the works.publication_type enum values they union to. This is the
// SINGLE source of truth for the mapping; the search-intent card's "Document
// type" multi-select and any other caller must reference this const rather than
// re-listing the values. The union of the selected groups' values is sent as
// `SearchFilters.publicationTypes`. Empty selection = no group chosen = ALL
// document types (the server treats an empty/undefined publicationTypes as
// "no filter" — see buildPreFiltersFromSearchFilters in retrieval.ts).
export const PUBLICATION_TYPE_GROUPS: { id: string; label: string; detail: string; values: PublicationType[] }[] = [
  { id: 'journal',   label: 'Journal articles',          detail: 'Peer-reviewed journal publications.',                values: ['journal_article'] },
  { id: 'wp',        label: 'Working papers',             detail: 'Working papers, discussion papers, and preprints.',  values: ['working_paper', 'discussion_paper', 'preprint'] },
  { id: 'report',    label: 'Reports / gray literature',  detail: 'Institutional reports and technical notes.',         values: ['report'] },
  { id: 'book',      label: 'Books',                      detail: 'Books and book chapters.',                           values: ['book', 'book_chapter'] },
];

// Union the values of the selected document-type group ids into the flat
// publication_type list sent to the server. Empty in → empty out = no filter.
export function documentTypeGroupsToPublicationTypes(groupIds: string[]): PublicationType[] {
  const out = new Set<PublicationType>();
  for (const gid of groupIds) {
    const grp = PUBLICATION_TYPE_GROUPS.find((g) => g.id === gid);
    if (grp) for (const v of grp.values) out.add(v);
  }
  return [...out];
}

// Reverse map: which group ids are "on" given a stored flat publicationTypes
// list. A group is considered selected when ANY of its values is present (so
// the UI round-trips a selection back to checked groups).
export function publicationTypesToDocumentTypeGroups(types: string[] | undefined): string[] {
  if (!types || types.length === 0) return [];
  const set = new Set(types);
  return PUBLICATION_TYPE_GROUPS.filter((g) => g.values.some((v) => set.has(v))).map((g) => g.id);
}

// ── Population groups (Q: population focus on the search-intent card) ───────
// Axis-grouped population segments for the pre-search clarifying question.
// Used by the UI chip catalog and by normalizePopulationFocus below.
// Source of truth: add/rename here; callers read POPULATION_GROUPS.
export const POPULATION_GROUPS = [
  { id: 'children',      axis: 'Life stage', label: 'Children' },
  { id: 'adolescents',   axis: 'Life stage', label: 'Adolescents / youth' },
  { id: 'adults',        axis: 'Life stage', label: 'Adults' },
  { id: 'women',         axis: 'Gender',     label: 'Women / girls' },
  { id: 'men',           axis: 'Gender',     label: 'Men / boys' },
  { id: 'low_income',    axis: 'Income',     label: 'Low-income' },
  { id: 'middle_income', axis: 'Income',     label: 'Middle-income' },
  { id: 'high_income',   axis: 'Income',     label: 'High-income' },
  { id: 'rural',         axis: 'Setting',    label: 'Rural' },
  { id: 'urban',         axis: 'Setting',    label: 'Urban' },
] as const;

// Normalise SearchFilters.populationFocus to a deduplicated, trimmed string[].
// Handles legacy single-string values from saved runs, as well as null/undefined.
export function normalizePopulationFocus(v: string | string[] | undefined | null): string[] {
  const arr = v == null ? [] : Array.isArray(v) ? v : [v];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of arr) {
    const t = (s ?? '').trim();
    if (t && !seen.has(t)) { seen.add(t); out.push(t); }
  }
  return out;
}

export interface SearchFilters {
  topics: string[];
  regions: string[];
  timePeriod: 'all' | 'recent' | 'custom' | '2000+';
  startDate: string;
  endDate: string;
  allSources: boolean;
  smsLevels: number[];
  // deprecated — kept for back-compat with legacy saved runs; not used in retrieval
  absRatings: string[];
  // deprecated — kept for back-compat with legacy saved runs; not used in retrieval
  repecBands: RepecBand[];
  // Active retrieval channels (Q1). Sent as channelsOverride on the search-run
  // request. Values are VALID_CHANNEL_IDS. Optional — absent on legacy runs.
  channels?: ChannelId[];
  // Document-type filter — keys match the DB enum on works.publication_type.
  // The UI selects GROUPS (see PUBLICATION_TYPE_GROUPS) and stores the unioned
  // flat values here. Empty / undefined = no filter = ALL document types
  // (the server treats both the same — see buildPreFiltersFromSearchFilters).
  publicationTypes?: string[];
  // New chip-bar fields (added 2026-05-04 for redesigned filter UX).
  // Source filters are enforced in retrieval as an explicit source universe.
  // Product default: IADB + ABS 4*/4 journal groups + core working-paper sources.
  journalTiers?: number[];
  excludedJournalsByTier?: Partial<Record<number, string[]>>;
  workingPaperSources?: string[];
  institutionalSources?: string[];
  // Opt-in (2026-06-26): also include journal articles in venues with no ABS
  // rating (unranked/regional/specialist). Additive to the source pickers; the
  // default journal-tier hard filter would otherwise drop them. Default false.
  includeUnranked?: boolean;
  // Wave 1 (2026-05-07): Direct/Indirect evidence toggle.
  //   direct — only papers matching every query facet
  //   both   — direct + indirect (SEMANTIC DEFAULT: when this field is absent
  //            the server treats it as 'both' — see retrieval.ts. An old brief
  //            or persona re-render that omits it must NOT silently skip the
  //            classification filter.)
  //   all    — show everything including loose matches
  // Backend ignores this when ENABLE_FACET_RETRIEVAL is off.
  evidenceMatch?: 'direct' | 'both' | 'all';
  // Population focus chosen on the pre-search clarifying card (query-aware
  // population question, 2026-06-10). Array of human labels (e.g. ["Women / girls",
  // "Low-income"]); undefined / empty = no specific focus.
  // Back-compat: legacy saved runs may carry a plain string — normalizePopulationFocus
  // handles both. 🔒 SYNTHESIS-EMPHASIS ONLY — consumed by the brief synthesis prompt
  // (promptFamilies.synthesis POPULATION FOCUS HARD RULE). NEVER a retrieval
  // predicate: eval 2026-06-10 showed population terms in retrieval are
  // neutral-to-negative. Do NOT add this field to retrieval.ts's SearchFilters
  // mirror (check-invariants #6 allows the mirror to be a subset).
  populationFocus?: string[];
}

export interface SearchIntent {
  entities: string[];
  synonyms: string[];
  geography: string[];
  timeframe: string;
  methodologyFocus: MethodologyDesign[];
}

export interface SearchRun {
  id: string;
  tenantId: string;
  query: string;
  filters: SearchFilters;
  createdAt: string;
  intent: SearchIntent;
  candidateWorkIds: string[];
  evidenceWorkIds: string[];
  signalWorkIds: string[];
  coverage: {
    universeCount: number;
    retrievedCount: number;
    admissibleCount: number;
    evidenceCount: number;
    signalCount: number;
    // Facet-retrieval telemetry (populated when ENABLE_FACET_RETRIEVAL=true).
    // (Direct/Indirect classifier counts removed 2026-07-08 — classifier retired.)
    excludedByFacets?: number;
    facetLabels?: string[];
  };
  retrievalNotes: string[];
  // Wave 2 (2026-05-07): per-paper Direct/Indirect classification map.
  // Keyed by work id. Null when facet retrieval was off.
  evidenceClassification?: Record<string, {
    evidenceMatch: 'direct' | 'indirect' | 'excluded';
    facetsMatched: string[];
    facetsMissed: string[];
  }> | null;
  // Decomposed query facets used to derive the classification.
  queryFacets?: Array<{ label: string; expansion: string[]; required?: boolean }> | null;
  // Channel-of-origin provenance (2026-06-03): workId -> channel ids
  // (causal / recent / foundational / lac) that actually surfaced the paper.
  // Additive telemetry; null/absent on legacy rows (frontend falls back to the
  // deterministic tagChannels priority recompute).
  workChannels?: Record<string, string[]> | null;
  // Topicality segments (2026-06-25): workId -> 'core'|'context'|'off' (+ a '_core'
  // concept string). Recall-safe display signal computed at brief time; null on legacy runs.
  workSegments?: Record<string, string> | null;
  // Load-more availability: set when extended evidence was computed at search time.
  hasMoreEvidence?: boolean;
  extendedEvidenceCount?: number;
}

export interface EvidenceRow {
  workId: string;
  title: string;
  authors: string[];
  sourceName: string;
  year: number;
  methodologyBadge: string;
  causalStrength: CausalStrength;
  smsLevel?: number | null;
  citationCount?: number | null;
  isFoundational?: boolean;
  geography: string[];
  doi?: string;
  url: string;
  finding: string;
  sourceLanguage?: 'en' | 'es';
  // Channel-of-origin (2026-06-03): the retrieval channel ids
  // (causal / recent / foundational / lac) that actually surfaced this paper,
  // sourced from SearchRun.workChannels. When present, BriefView derives the
  // channel pills from these TRUE channels; when absent it falls back to the
  // deterministic priority recompute in tagChannels().
  retrievalChannels?: string[];
  // Topicality segment (2026-06-25): 'core' = direct evidence, 'context' = related,
  // 'off' = likely off-topic (flagged for review, never auto-dropped). Sourced from
  // SearchRun.workSegments. Absent on legacy runs → table renders ungrouped.
  segment?: 'core' | 'context' | 'off';
  isManualAdd?: boolean;   // paper added manually by user in BriefView; not from retrieval
}

// ---------------------------------------------------------------------------
// Deep scan (2026-06-10): opt-in second retrieval round for an existing
// search run. POST /api/search-runs/:id/deep-scan returns the literatures the
// first pass missed, the follow-up sub-queries used, and the NEW papers those
// sub-queries surfaced. NOTE: 'deepscan' is a PROVENANCE tag on work_channels
// only — it is NOT a retrieval channel and must NOT be added to
// VALID_CHANNEL_IDS (that contract is guarded by check-invariants).
// ---------------------------------------------------------------------------
export interface DeepScanNewWork {
  id: string;
  title: string;
  authors: string[];
  year: number | null;
  venue: string | null;
  similarity: number | null;
  smsLevel: number | null;
  citationCount: number | null;
  abstract: string | null;
}

export interface DeepScanResponse {
  missing: string[];
  subQueries: string[];
  newWorks: DeepScanNewWork[];
}

export type PlannerKind = 'gemini' | 'qwen';

export interface PlannerAddedPaper {
  id: string;
  title: string;
  authors: string[];
  year: number | null;
  venue: string | null;
  citationCount: number | null;
  smsLevel: number | null;
  similarity: number;
  via: string;
  why: string;
  tier: 'evidence' | 'context';
}

export interface PlannerDroppedProposal {
  id?: string;
  label: string;
  reason: 'evaporated' | 'low_relevance' | 'low_quality' | 'low_quality_noise' | 'already_in_table' | 'duplicate' | 'over_cap';
}

export interface ExpandEvidenceResponse {
  planner: PlannerKind;
  model: PlannerKind | null;
  query: string;
  added: PlannerAddedPaper[];
  dropped: PlannerDroppedProposal[];
  plan: { subQueries: string[]; literatures: string[]; namedWorks: number };
}

export type GapType = 'research_gap' | 'retrieval_issue' | 'methodological_gap' | 'regional_gap' | null;

export interface CoverageCard {
  universeCount: number;
  retrievedCount: number;
  admissibleCount: number;
  evidenceCount: number;
  signalCount: number;
  gapSummary: string;
  regionalGap: string;
  thinEvidenceAreas?: string;
  methodologicalGap: string;
  gapType?: GapType;
  // Phase 2 additions — LAC sub-region grid, time-window callout, and a
  // rule-based "next move" suggestion keyed off gapType. Optional so old
  // briefs without these fields still render via the legacy paragraphs.
  lacCoverage?: {
    covered: { country: string; count: number }[];
    uncovered: string[];
  };
  recencyGap?: string | null;
  nextMileAction?: string | null;
}

export interface AuditTrace {
  model: string;
  promptVersions: Record<string, string>;
  retrievalPolicy: string;
  queryPlan: string[];
  generatedAt: string;
  notes: string[];
  persona?: PersonaId;
  lang?: 'en' | 'es' | 'pt';
  savedToLibrary?: boolean;
}

export interface EvidenceBriefSections {
  summaryBullets: string[];
  evidenceRows: EvidenceRow[];
  methodologyNote: string;
  coverageCard: CoverageCard;
  followUpQuestions: string[];
  citations: string[];
  warnings: string[];
  abstractSummary?: string;
  strongestEvidence?: string;
  threadTweets?: ThreadTweet[];
}

export interface EvidenceBrief {
  id: string;
  tenantId: string;
  searchRunId: string;
  status: BriefStatus;
  query: string;
  sections: EvidenceBriefSections;
  auditTrace: AuditTrace;
  createdAt: string;
  sharePath: string;
}

export interface AlertSubscription {
  id: string;
  tenantId: string;
  type: 'topic' | 'author' | 'search';
  label: string;
  cadence: 'daily' | 'weekly';
  query?: string;
  authorId?: string;
  topic?: string;
}

export interface FeedItem {
  id: string;
  tenantId: string;
  kind: FeedItemKind;
  title: string;
  reason: string;
  createdAt: string;
  linkedEntityId: string;
}

export interface FeedbackEvent {
  id: string;
  tenantId: string;
  briefId?: string;
  workId?: string;
  type: FeedbackRating;
  reason?: string;
  createdAt: string;
  // Write-only request hints (not persisted as columns): let the server resolve
  // the originating query to embed on the row, powering the per-query dislike
  // suppression + positive promote filters. Provide ONE of: queryText (direct),
  // searchRunId (run→query), or briefId (brief→run→query).
  searchRunId?: string;
  queryText?: string;
}

export interface DomainWeight {
  id: string;
  userId: string;
  domain: string;
  alpha: number;
  betaParam: number;
  weight: number;
  signalCount: number;
  updatedAt: string;
}

export interface WeightProposal {
  id: string;
  userId: string;
  domain: string;
  currentWeight: number;
  proposedWeight: number;
  explanation: string;
  signalCount: number;
  driftPct: number | null;
  status: 'pending' | 'approved' | 'rejected';
  createdAt: string;
  reviewedAt: string | null;
}

export interface WeightAlert {
  id: string;
  alertType: string;
  message: string;
  totalDriftPct: number;
  createdAt: string;
  resolvedAt: string | null;
}

export type RetrievalAuditVerdict =
  | 'good_coverage'
  | 'partial_coverage'
  | 'likely_missing_key_evidence'
  | 'filter_mismatch'
  | 'retrieval_failure';

export interface ExpectedEvidenceAuditItem {
  title: string;
  doi?: string | null;
  authors?: string[];
  year?: number | null;
  source?: string | null;
  whyExpected: string;
  expectedUnderFilters: boolean;
  matchedWorkId?: string;
  status: 'present' | 'missing' | 'excluded_by_filter' | 'not_in_corpus' | 'near_duplicate_present';
  adminRelevance?: 'relevant' | 'not_relevant' | null;
}

export interface RetrievalAudit {
  id: string;
  tenantId: string;
  searchRunId: string;
  query: string;
  verdict: RetrievalAuditVerdict;
  confidence: number;
  auditMode: 'corpus' | 'external';
  externalDiagnostics?: {
    openAlexCount: number;
    semanticScholarCount: number;
    llmCanonicalCount: number;
    llmSearchQueryCount?: number;
    llmSearchQueries?: string[];
  };
  expectedEvidence: ExpectedEvidenceAuditItem[];
  tableDiagnostics: {
    directMatchCount: number;
    indirectMatchCount: number;
    offTopicCount: number;
    wrongGeographyCount: number;
    wrongMethodologyCount: number;
    yearFilterViolations: number;
    sourceFilterViolations: number;
    inCorpusButMissingCount: number;
    expectedPresentCount: number;
  };
  recommendedActions: string[];
  auditVersion: string;
  createdAt: string;
}

export interface ChatMessage {
  id: string;
  briefId: string;
  role: 'user' | 'model';
  content: string;
  citations: string[];
  createdAt: string;
}

export interface AdminSourceReview {
  sourceId: string;
  approved: boolean;
  note: string;
}

export interface UserPreferences {
  defaultPersona: PersonaId;
  regionalFocus: string[];
  methodologyFocus: string[];
  emailAlertsEnabled: boolean;
}

export interface SavedPaper {
  feedbackId: string;
  workId: string;
  briefId?: string;
  savedAt: string;
  title: string;
  year: number | null;
  venue: string | null;
  smsLevel: number | null;
  canonicalDoi: string | null;
  url: string | null;
}

// ---------------------------------------------------------------------------
// JEL Paper — long-form survey articles generated async from evidence briefs
// ---------------------------------------------------------------------------

export type JelPaperStatus = 'planning' | 'queued' | 'running' | 'done' | 'error';

export interface PaperPlanEmphasis {
  themes: string[];
  spotlightDebate?: string;
  audience: 'policy' | 'technical';
  targetWords: number;
}

export interface PaperPlanUpload {
  uploadId: string;
  title: string;
  authors: string[];
  year?: number | null;
  doi?: string | null;
  abstract?: string | null;
  venue?: string | null;
  smsLevel?: number | null;
  matchedWorkId?: string | null;
  source: 'doi' | 'paste' | 'pdf';
  // Grounded evidence card extracted from the document (Wave 2) — used in generation.
  card?: {
    design: string | null; intervention: string | null; outcome: string | null;
    effectDirection: string | null; findingShort: string | null; mechanism: string | null;
  } | null;
}

export type UploadKind = 'add_existing' | 'add_new';   // existing=retrieval miss, new=corpus gap

export interface UploadPreview {
  upload: PaperPlanUpload;   // the resolved/extracted metadata card
  inCorpus: boolean;         // true when matchedWorkId is set (we already have it)
  kind: UploadKind;          // derived: add_existing when inCorpus, else add_new
  alreadyInPlan?: boolean;   // true when this paper is already in the plan's curated set / uploads
}

export interface PaperPlanOutline {
  title: string;
  sections: { number: number; heading: string; scope: string }[];
}

export interface ClarifyingQuestion {
  q: string;
  options: string[];
  rationale: string;   // why the evidence makes this question worth asking
}

export interface AlwaysAskStaples {
  audience: ('policy' | 'technical')[];
  lengthOptions: number[];   // target word counts, e.g. [10000, 14000, 18000]
}

export interface PaperPlanClarification {
  clarifyingQuestions: ClarifyingQuestion[];   // 0–3, evidence-derived
  alwaysAsk: AlwaysAskStaples;
  workingQuestion: string;
  draftOutline: PaperPlanOutline | null;
  degraded: boolean;   // true when LLM was unavailable and we returned the "use query as-is" shape
}

// Paper Studio length picker: users choose PAGES; we store targetWords.
// Short by design: JEL surveys offer 5 or 10 pages only (2026-06-26) — no 2pg, no 20-30pg.
export const WORDS_PER_PAGE = 500;
export const PAGE_PRESETS = [5, 10] as const;

export type GenerateMode = 'deep' | 'standard';   // deep = Gemini-led, standard = Qwen-hybrid

export interface PaperPlan {
  workingQuestion: string;
  scope: { include: string[]; exclude: string[] };
  // Seeded in the brief's DISPLAYED order (what the user saw), not raw evidence_work_ids order.
  curatedWorkIds: string[];
  removedWorkIds: string[];
  discoveredWorkIds?: string[];
  uploads: PaperPlanUpload[];
  emphasis: PaperPlanEmphasis;
  outlinePreview: PaperPlanOutline | null;
  clarifyAnswers?: { question: string; answer: string }[];
  generateMode?: GenerateMode;   // set by write-first Generate Now; absent → 'standard'
}

export interface JelOutlineSection {
  number: string;
  heading: string;
  scope: string;
  targetWords: number;
  expectedDesigns?: string[];
}

export interface JelOutline {
  title: string;
  abstract: string;
  sections: JelOutlineSection[];
  coherenceReport?: Record<string, unknown> | null;
  auditReport?: Record<string, unknown> | null;
  krisReport?: Record<string, unknown> | null;
  correctorReport?: Record<string, unknown> | null;
  // Evidence provenance (2026-06-03): which retrieval channels + filters
  // produced this paper's evidence set. Additive; absent on legacy papers.
  retrievalMetadata?: {
    channels: string[];
    channelCounts?: Record<string, number>;
    evidenceCount?: number;
    searchRunId?: string | null;
    query?: string | null;
    filters?: {
      regions?: string[] | null;
      timePeriod?: string | null;
      startDate?: string | null;
      endDate?: string | null;
      sourceIds?: string[] | null;
      topics?: string[] | null;
      methodology?: string[] | null;
      tiers?: string[] | null;
    };
  } | null;
}

export interface JelSection {
  number: string;
  heading: string;
  body: string;
  citedWorkIds: string[];
  wordCount: number;
  // Prior body, captured the last time this section was revised, for the
  // before/after diff. Only the most recent prior body is kept. Absent until a
  // section is revised; absent on legacy papers.
  previousBody?: string;
}

export interface JelBibEntry {
  number: number;
  workId: string;
  authors: string;
  year: number | null;
  title: string;
  venue: string | null;
  doi: string | null;
  unverified?: boolean;   // user-supplied upload — metadata not corpus-vetted
  cited?: boolean;        // true if this evidence paper was cited in the prose
}

export interface RevisionLogEntry {
  n: number;                 // 1-based revision number
  instruction: string;       // raw composed instruction the user submitted
  directive: string;         // normalized directive the router produced
  targetSections: string[];  // section numbers the router targeted
  sectionsRevised: number;   // how many were actually re-drafted
  at: string;                // ISO timestamp
}

export interface JelPaper {
  id: string;
  tenantId: string;
  searchRunId: string;
  briefId?: string | null;
  status: JelPaperStatus;
  query: string;
  outline?: JelOutline | null;
  sections: JelSection[];
  bibliography: JelBibEntry[];
  wordCount?: number | null;
  citationCount?: number | null;
  errorMessage?: string | null;
  createdAt: string;
  completedAt?: string | null;
  plan?: PaperPlan | null;
  regenerationsUsed?: number;
  revisionLog?: RevisionLogEntry[];
  // Corpus Work rows for the bibliography workIds, embedded by GET
  // /api/jel-papers/:id so exports can show the rich evidence-table attributes
  // (SMS, methodology, region, citations) that don't live on JelBibEntry.
  evidenceWorks?: Work[];
}

export interface AppStateSnapshot {
  tenantId: string;
  sources: SourceRecord[];
  works: Work[];
  searchRuns: SearchRun[];
  briefs: EvidenceBrief[];
  subscriptions: AlertSubscription[];
  feed: FeedItem[];
  feedback: FeedbackEvent[];
  domainWeights: DomainWeight[];
  weightProposals: WeightProposal[];
  weightAlerts: WeightAlert[];
  jelPapers: JelPaper[];  // may be absent on older snapshots — default to []
}

export interface XPost {
  id: string;
  url: string;
  text: string;
  author: string | null;
  publishedDate: string | null;
  title: string | null;
}

export type SignalProfile = 'policy' | 'buzz';

export interface SignalItem {
  id: string;
  title: string;
  url: string | null;
  snippet: string | null;
  publishedDate: string | null;
  domain: string | null;
  author: string | null;
  profile: SignalProfile;
}

export interface SignalsResult {
  policy: SignalItem[];
  buzz: SignalItem[];
}

// --- SCL pilot monitoring (admin) ---
export interface MonitorActionHealth { action: 'search'|'brief'|'chat'|'paper'; attempts: number; completed: number; failed: number; successRate: number|null; stuck: { targetId: string|null; startedTs: string; ageMs: number }[]; failures: { targetId: string|null; ts: string; error: string|null }[]; p50: number|null; p95: number|null; }
export interface MonitorOverview { roster: string[]; health: MonitorActionHealth[]; byUser: Record<string, Record<string, number>>; windowDays: number; }
export interface MonitorCost { cost: { total: number; today: number; last7d: number; projected30d: number; byProvider: Record<string, number>; byModel: Record<string, number>; byOperation: Record<string, number>; byUser: Record<string, number> }; budget: { provider: string; budgetUsd: number; spentUsd: number; remainingUsd: number; pctConsumed: number; burnPerDay: number; etaDays: number|null }[]; }
export interface MonitorAlert { id: string; severity: 'warn'|'critical'; title: string; detail: string; entities: string[]; fingerprint: string; }
export interface MonitorActivityEvent { id: string; ts: string; event_type: string; status: string|null; error: string|null; latency_ms: number|null; target_type: string|null; target_id: string|null; payload?: any; }
