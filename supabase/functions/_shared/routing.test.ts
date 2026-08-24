import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { extractPathParam, lastPathSegment, validatePayload } from "./routing.ts";

Deno.test("lastPathSegment: plain id", () => {
  assertEquals(lastPathSegment("/api/jel-papers/abc-123"), "abc-123");
});

Deno.test("lastPathSegment: strips query string", () => {
  assertEquals(lastPathSegment("/api/jel-papers/abc-123?foo=bar"), "abc-123");
});

Deno.test("lastPathSegment: strips trailing slash + fragment", () => {
  assertEquals(lastPathSegment("/api/jel-papers/abc-123/#x"), "abc-123");
});

Deno.test("lastPathSegment: url-decodes", () => {
  assertEquals(lastPathSegment("/api/jel-papers/a%20b"), "a b");
});

Deno.test("lastPathSegment: empty when no segment", () => {
  assertEquals(lastPathSegment("/api/jel-papers/"), "jel-papers");
});

Deno.test("extractPathParam: matches and extracts middle param", () => {
  assertEquals(extractPathParam("/api/briefs/xyz/chat", "/api/briefs/:id/chat", "id"), "xyz");
});

Deno.test("extractPathParam: tolerates trailing slash + query", () => {
  assertEquals(extractPathParam("/api/briefs/xyz/chat/?q=1", "/api/briefs/:id/chat", "id"), "xyz");
});

Deno.test("extractPathParam: returns null on segment-count mismatch", () => {
  assertEquals(extractPathParam("/api/briefs/xyz", "/api/briefs/:id/chat", "id"), null);
});

Deno.test("extractPathParam: returns null on literal mismatch", () => {
  assertEquals(extractPathParam("/api/briefs/xyz/notes", "/api/briefs/:id/chat", "id"), null);
});

Deno.test("validatePayload: ok when fields valid", () => {
  assertEquals(validatePayload({ query: "hello" }, { query: { type: "string", required: true } }), null);
});

Deno.test("validatePayload: missing required", () => {
  assertEquals(validatePayload({}, { query: { type: "string", required: true } }), "query is required");
});

Deno.test("validatePayload: wrong type", () => {
  assertEquals(validatePayload({ query: 5 }, { query: { type: "string" } }), "query must be a string");
});

Deno.test("validatePayload: oversized string", () => {
  assertEquals(
    validatePayload({ q: "x".repeat(11) }, { q: { type: "string", maxLen: 10 } }),
    "q exceeds maximum length 10",
  );
});

Deno.test("validatePayload: array type + length", () => {
  assertEquals(validatePayload({ ids: [1, 2, 3] }, { ids: { type: "array", maxLen: 2 } }), "ids exceeds maximum length 2");
  assertEquals(validatePayload({ ids: [1] }, { ids: { type: "array", maxLen: 2 } }), null);
});

Deno.test("validatePayload: absent optional is fine", () => {
  assertEquals(validatePayload({}, { note: { type: "string" } }), null);
});

Deno.test("validatePayload: non-object body", () => {
  assertEquals(validatePayload(null, { q: { type: "string" } }), "body must be a JSON object");
  assertEquals(validatePayload([], { q: { type: "string" } }), "body must be a JSON object");
});
