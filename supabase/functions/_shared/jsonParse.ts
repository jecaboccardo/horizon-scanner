// Lenient JSON recovery — runs ONLY after a strict JSON.parse fails, so it can
// never regress a currently-passing parse. Handles (1) markdown ```json fences /
// prose around the object, and (2) RAW newlines/tabs inside string values.
// deno-lint-ignore no-explicit-any
export function lenientJsonParse(text: string): any {
  try { return JSON.parse(text); } catch { /* fall through */ }
  let s = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  const first = s.indexOf("{");
  const last = s.lastIndexOf("}");
  if (first >= 0 && last > first) s = s.slice(first, last + 1);
  try { return JSON.parse(s); } catch { /* fall through */ }
  let out = "";
  let inStr = false, esc = false;
  for (const ch of s) {
    if (esc) { out += ch; esc = false; continue; }
    if (ch === "\\") { out += ch; esc = true; continue; }
    if (ch === '"') { inStr = !inStr; out += ch; continue; }
    if (inStr && ch === "\n") { out += "\\n"; continue; }
    if (inStr && ch === "\r") { out += "\\r"; continue; }
    if (inStr && ch === "\t") { out += "\\t"; continue; }
    out += ch;
  }
  return JSON.parse(out);
}
