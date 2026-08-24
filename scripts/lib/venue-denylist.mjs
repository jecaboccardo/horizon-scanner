import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_DENYLIST_PATH = join(process.cwd(), "data", "corpus-venue-denylist.json");

function normalizeVenue(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

export function loadVenueDenylist(path = DEFAULT_DENYLIST_PATH) {
  if (!existsSync(path)) {
    return {
      path,
      venues: [],
      normalized: new Set(),
      generatedAt: null,
    };
  }

  const parsed = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
  const venues = Array.isArray(parsed.venues) ? parsed.venues : [];
  return {
    path,
    venues,
    normalized: new Set(venues.map((venue) => normalizeVenue(venue)).filter(Boolean)),
    generatedAt: parsed.generated_at ?? parsed.generatedAt ?? null,
  };
}

export function isDeniedVenue(venue, denylist) {
  if (!venue || !denylist?.normalized?.size) return false;
  return denylist.normalized.has(normalizeVenue(venue));
}

export function filterDeniedVenues(rows, denylist, venueKey = "venue") {
  if (!denylist?.normalized?.size) return rows;
  return rows.filter((row) => !isDeniedVenue(row?.[venueKey], denylist));
}
