// SCL pilot roster. UUIDs come from env SCL_ROSTER_UUIDS (comma-separated) so the
// roster is editable without a deploy. See the design spec §4.
function readEnv(key: string): string | undefined {
  // deno-lint-ignore no-explicit-any
  const d = (globalThis as any).Deno?.env;
  if (d && typeof d.get === "function") return d.get(key) ?? undefined;
  // deno-lint-ignore no-explicit-any
  return (globalThis as any).process?.env?.[key];
}

export function parseRoster(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

export function getRoster(): string[] {
  return parseRoster(readEnv("SCL_ROSTER_UUIDS"));
}

/** PostgREST `.or()` argument matching either attribution column. Empty roster → "". */
export function rosterOrFilter(uuids: string[]): string {
  if (uuids.length === 0) return "";
  const list = uuids.join(",");
  return `tenant_id.in.(${list}),user_id.in.(${list})`;
}
