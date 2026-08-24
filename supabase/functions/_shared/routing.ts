// Small, dependency-free helpers for the api/index.ts route switch.
//
// Why this exists: handlers historically pulled path ids with
// `path.split("/").pop()` and trusted request bodies without validation. A
// trailing slash / query string turned a valid id into "" (silent 404), and an
// oversized/wrong-typed body could reach the DB layer. These helpers make id
// extraction and payload checks explicit and uniform. Pure functions — unit
// tested in routing.test.ts, no Deno/Supabase imports.

/**
 * Trailing path segment, with query string (`?...`), fragment (`#...`), and
 * trailing slashes stripped, then URL-decoded. Returns "" if there is no
 * segment. Use for `/api/thing/:id` style routes.
 */
export function lastPathSegment(path: string): string {
  const noQuery = path.split("?")[0].split("#")[0];
  const trimmed = noQuery.replace(/\/+$/, "");
  const seg = trimmed.split("/").pop() ?? "";
  try {
    return decodeURIComponent(seg).trim();
  } catch {
    return seg.trim();
  }
}

/**
 * Extract a named param from `path` matched against a pattern like
 * "/api/briefs/:id/chat". Returns the decoded value, or null if the path does
 * not structurally match the pattern (different segment count or a literal
 * segment mismatch). Safer than positional `split("/")[3]` indexing.
 */
export function extractPathParam(
  path: string,
  pattern: string,
  name: string,
): string | null {
  const clean = path.split("?")[0].split("#")[0].replace(/\/+$/, "");
  const pParts = pattern.replace(/\/+$/, "").split("/");
  const aParts = clean.split("/");
  if (pParts.length !== aParts.length) return null;
  let found: string | null = null;
  for (let i = 0; i < pParts.length; i++) {
    if (pParts[i].startsWith(":")) {
      if (pParts[i].slice(1) === name) {
        try {
          found = decodeURIComponent(aParts[i]).trim();
        } catch {
          found = aParts[i].trim();
        }
      }
    } else if (pParts[i] !== aParts[i]) {
      return null;
    }
  }
  return found && found.length ? found : null;
}

export type FieldSpec = {
  type: "string" | "number" | "boolean" | "array" | "object";
  maxLen?: number; // max string length OR max array length
  required?: boolean;
};

/**
 * Validate a parsed JSON body against a tiny field schema. Returns an error
 * string suitable for a 400 response, or null when the body is acceptable.
 * Only checks declared fields (extra fields are ignored). Absent + not required
 * is fine; absent + required is an error.
 */
export function validatePayload(
  body: unknown,
  schema: Record<string, FieldSpec>,
): string | null {
  if (body == null || typeof body !== "object" || Array.isArray(body)) {
    return "body must be a JSON object";
  }
  const obj = body as Record<string, unknown>;
  for (const [key, spec] of Object.entries(schema)) {
    const v = obj[key];
    if (v == null) {
      if (spec.required) return `${key} is required`;
      continue;
    }
    const actual = Array.isArray(v) ? "array" : typeof v;
    if (actual !== spec.type) return `${key} must be a ${spec.type}`;
    if (spec.maxLen != null) {
      const len = spec.type === "string"
        ? (v as string).length
        : spec.type === "array"
        ? (v as unknown[]).length
        : null;
      if (len != null && len > spec.maxLen) {
        return `${key} exceeds maximum length ${spec.maxLen}`;
      }
    }
  }
  return null;
}
