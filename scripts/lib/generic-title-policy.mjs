const GENERIC_TITLE_PATTERNS = [
  /^general discussion$/i,
  /^comments? and discussion$/i,
  /^discussion$/i,
  /^editors?[‘’]?\s+introduction$/i,
  /^editors?.*summary$/i,
  /^introduction$/i,
  /^front matter$/i,
  /^back matter$/i,
  /^book reviews?$/i,
  /^award given by (?:the\s+)?vernon prize committee\b/i,
  /^panel on\b/i,
  /^(?:the\s+)?journal of human resources\s+index\s+\d{4}\s+volume\s+[xivxlcdm]+$/i,
  /^index to volume\s+\d+$/i,
  // Society administrative / editorial content
  /\bannual report\b/i,
  /\breport of the (?:president|treasurer|secretary)\b/i,
  /^minutes of\b/i,
  /\bin memoriam\b/i,
  /^acknowledgm?ents? of (?:reviewers?|referees?)/i,
  /^list of (?:reviewers?|referees?)/i,
  /^notes? and comments?$/i,
  /^comment on\b/i,
  // Supplemental / appendix material
  /^supplemental material\b/i,
  /^online appendix\b/i,
  /^web appendix\b/i,
  // Society admin
  /\bcode of ethics\b/i,
  /\bbrattle group\b/i,
  /^american finance association$/i,
  /\bpreliminary program\b/i,
  /\bexcellence in refereeing\b/i,
  /\bad.?hoc reviewers?\b/i,
  // Replies and rejoinders — discussion responses, not primary evidence
  /\ba reply$/i,
  /:\s*a reply$/i,
  /\breply to\b/i,
  /\brejoinder\b/i,
  // Errata / corrections
  /^corrections?$/i,
  /^correction to\b/i,
  /^correction:/i,
  /^errata\b/i,
  /^corrigendum\b/i,
];

export function normalizeGenericTitle(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/[^a-z0-9'\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function isGenericNonPrimaryTitle(title) {
  const normalized = normalizeGenericTitle(title);
  if (!normalized) return false;
  return GENERIC_TITLE_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function filterGenericNonPrimaryRows(rows, titleKey = "title") {
  return rows.filter((row) => !isGenericNonPrimaryTitle(row?.[titleKey]));
}

export const GENERIC_NON_PRIMARY_REASON = "generic discussion/commentary";
