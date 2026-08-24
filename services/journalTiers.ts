import journalTiersConfig from '../data/journal-tiers.json' with { type: 'json' };

export type JournalTier = 1 | 2 | 3 | 4 | 5;

export interface TierMetadata {
  tier: JournalTier;
  label: string;
  description: string;
  journals: readonly string[];
}

const NORMALIZE = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, ' ');

const venueToTier: Map<string, JournalTier> = new Map();

const buildLookup = (): void => {
  const sets: Array<[JournalTier, readonly string[]]> = [
    [1, journalTiersConfig.tier1_top5_econ],
    [2, journalTiersConfig.tier2_abs_4_and_4star],
    [3, journalTiersConfig.tier3_abs_3],
    [4, journalTiersConfig.tier4_field_specific_and_lac],
  ];
  for (const [tier, venues] of sets) {
    for (const v of venues) venueToTier.set(NORMALIZE(v), tier);
  }
};

buildLookup();

export const getTierForVenue = (venue: string | null | undefined): JournalTier => {
  if (!venue) return 5;
  return venueToTier.get(NORMALIZE(venue)) ?? 5;
};

export const getJournalsInTier = (tier: JournalTier): readonly string[] => {
  if (tier === 1) return journalTiersConfig.tier1_top5_econ;
  if (tier === 2) return journalTiersConfig.tier2_abs_4_and_4star;
  if (tier === 3) return journalTiersConfig.tier3_abs_3;
  if (tier === 4) return journalTiersConfig.tier4_field_specific_and_lac;
  return [];
};

/**
 * 🔑 The internal `journalTiers` numbering is INVERTED vs the ABS scale:
 * tier 1 = ABS 4★ (best) … tier 4 = ABS 1–2. To avoid the mental remap, always
 * render tiers through these helpers (never show the raw tier number as if it
 * were an ABS rating — that produced the "ABS 1/2/3★" mislabel for the default).
 */
export const TIER_TO_ABS: Record<JournalTier, string> = {
  1: '4★', 2: '4', 3: '3', 4: '1–2', 5: 'unranked',
};

/** Human ABS-band label for a set of internal journal tiers, e.g. [1,2,3] → "ABS 3+". */
export const absBandLabel = (tiers: readonly JournalTier[] | readonly number[]): string => {
  if (!tiers || tiers.length === 0) return '';
  const s = [...new Set(tiers as number[])].sort((a, b) => a - b);
  const key = s.join(',');
  // Contiguous-from-the-top selections read most naturally as "ABS N+".
  if (key === '1,2,3,4,5') return 'All journals';
  if (key === '1,2,3,4') return 'ABS 1+';
  if (key === '1,2,3') return 'ABS 3+';   // the default
  if (key === '1,2') return 'ABS 4+';
  if (key === '1') return 'ABS 4★';
  return 'ABS ' + s.map((t) => TIER_TO_ABS[t as JournalTier] ?? String(t)).join('/');
};

export const getAllTiers = (): readonly TierMetadata[] => [
  {
    tier: 1,
    label: 'ABS 4*/4 journals',
    description: journalTiersConfig._meta.tiers['1'],
    journals: journalTiersConfig.tier1_top5_econ,
  },
  {
    tier: 2,
    label: 'ABS 4* / 4 journals',
    description: journalTiersConfig._meta.tiers['2'],
    journals: journalTiersConfig.tier2_abs_4_and_4star,
  },
  {
    tier: 3,
    label: 'ABS 3 journals',
    description: journalTiersConfig._meta.tiers['3'],
    journals: journalTiersConfig.tier3_abs_3,
  },
  {
    tier: 4,
    label: 'ABS 2 / 1 + LAC area-studies',
    description: journalTiersConfig._meta.tiers['4'],
    journals: journalTiersConfig.tier4_field_specific_and_lac,
  },
  {
    tier: 5,
    label: 'Unranked indexed venues',
    description: journalTiersConfig._meta.tiers['5'],
    journals: [],
  },
];
