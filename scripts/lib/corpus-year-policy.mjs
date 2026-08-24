import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_YEAR_DENYLIST_PATH = join(process.cwd(), "data", "corpus-year-denylist.json");

export function loadCorpusYearDenylist(path = DEFAULT_YEAR_DENYLIST_PATH) {
  if (!existsSync(path)) {
    return { path, yearLte: 1960, minAllowedYear: 1961, generatedAt: null };
  }
  const parsed = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
  const yearLte = Number(parsed.year_lte ?? parsed.yearLte ?? 1960);
  const minAllowedYear = Number(parsed.min_allowed_year ?? parsed.minAllowedYear ?? yearLte + 1);
  return {
    path,
    yearLte,
    minAllowedYear,
    generatedAt: parsed.generated_at ?? parsed.generatedAt ?? null,
  };
}

export const CORPUS_YEAR_DENYLIST = loadCorpusYearDenylist();
export const CORPUS_MIN_YEAR = CORPUS_YEAR_DENYLIST.minAllowedYear;

export function isDeniedCorpusYear(year, minYear = CORPUS_MIN_YEAR) {
  if (year == null || year === "") return false;
  const parsed = Number(year);
  if (!Number.isFinite(parsed)) return false;
  return parsed < minYear;
}

export function filterDeniedCorpusYears(rows, yearKey = "year", minYear = CORPUS_MIN_YEAR) {
  return rows.filter((row) => !isDeniedCorpusYear(row?.[yearKey], minYear));
}
