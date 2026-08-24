// Restrict CORS to specific origins via ALLOWED_ORIGINS env var (comma-separated).
// Defaults to "*" when unset — keeps local dev working without configuration.
// Set ALLOWED_ORIGINS on the deployed backend, e.g.:
//   ALLOWED_ORIGINS=https://v0-horizon-scanner-iadb.vercel.app,https://horizon-scanner-iadb-demo.vercel.app
// Note: json() and sseResponse() use the static _staticOrigin below. For full
// multi-origin support on those helpers, pass the request object to them (future refactor).
const _envOrigins = (typeof Deno !== "undefined"
  ? Deno.env.get("ALLOWED_ORIGINS")
  : (globalThis as any).process?.env?.ALLOWED_ORIGINS) ?? "";
const _allowedSet: Set<string> | null = _envOrigins
  ? new Set(_envOrigins.split(",").map((s: string) => s.trim()).filter(Boolean))
  : null;
const _staticOrigin = _allowedSet ? [..._allowedSet][0] : "*";

function _resolveOrigin(req: Request): string {
  if (!_allowedSet) return "*";
  const o = req.headers.get("origin") ?? "";
  return _allowedSet.has(o) ? o : "";
}

export const corsHeaders = {
  "Access-Control-Allow-Origin": _staticOrigin,
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-tenant-id",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
};

export function handleCors(req: Request): Response | null {
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: {
        ...corsHeaders,
        "Access-Control-Allow-Origin": _resolveOrigin(req),
        ...(_allowedSet ? { "Vary": "Origin" } : {}),
      },
    });
  }
  return null;
}

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

/** Format a single SSE event string. */
export function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** Return a streaming SSE Response with correct CORS and content-type headers. */
export function sseResponse(stream: ReadableStream): Response {
  return new Response(stream, {
    headers: {
      ...corsHeaders,
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      // nginx buffers proxied responses by default, which holds SSE frames
      // (including heartbeats) until the buffer fills — defeating both
      // streaming and keepalive. This header disables per-response buffering.
      "X-Accel-Buffering": "no",
    },
  });
}

/**
 * Keep a long-lived SSE connection alive across intermediate proxies.
 *
 * A slow synthesis call (e.g. BYOK Claude ≈75s) emits no SSE frames while the
 * provider request is in flight. The browser→Vercel→nginx→Deno path kills
 * connections that stay silent past its idle timeout (~30-60s), so the client
 * sees a clean close with no terminal event and reports "the connection
 * dropped" — even though the server finishes and persists the result.
 *
 * SSE comment frames (lines starting with ":") are ignored by EventSource per
 * spec AND by the frontend's hand-rolled parser (frames without event:/data:
 * lines are skipped), but they count as traffic and reset every idle timeout
 * on the path.
 *
 * Returns a stop function. Self-stops if the stream is already closed.
 */
export function startSseHeartbeat(
  controller: ReadableStreamDefaultController<Uint8Array>,
  intervalMs = 10_000,
): () => void {
  const encoder = new TextEncoder();
  const timer = setInterval(() => {
    try {
      controller.enqueue(encoder.encode(": hb\n\n"));
    } catch {
      clearInterval(timer); // stream closed between ticks — stop silently
    }
  }, intervalMs);
  return () => clearInterval(timer);
}
