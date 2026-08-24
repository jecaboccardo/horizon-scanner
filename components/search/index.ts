// components/search/index.ts
// Re-exports the conversational clarifier question components.
// (BreadthQuestion removed 2026-06-17 — classifier dropped; the cosine relevance
//  floor decides evidence-table size, so there is no breadth/direct-vs-both choice.)
export { PopulationQuestion }   from './PopulationQuestion';
export type { PopulationQuestionProps } from './PopulationQuestion';

export { EvidenceTypeQuestion } from './EvidenceTypeQuestion';
export type { EvidenceTypeQuestionProps } from './EvidenceTypeQuestion';

export { RegionQuestion }       from './RegionQuestion';
export type { RegionQuestionProps } from './RegionQuestion';

export { RecencyQuestion }      from './RecencyQuestion';
export type { RecencyQuestionProps } from './RecencyQuestion';

export { SourcesQuestion, SourcePicker, DefaultSourceSummary } from './SourcesQuestion';
export type { SourcesQuestionProps, SourcePickerProps } from './SourcesQuestion';
