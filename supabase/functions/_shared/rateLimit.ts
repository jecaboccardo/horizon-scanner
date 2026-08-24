/**
 * In-memory sliding-window rate limiter for the Deno single-process API.
 * State lives in module scope — persists across requests, resets on process restart.
 *
 * Intentionally simple: no Redis, no persistence, no cross-process coordination.
 * Suitable for a single Deno process behind a reverse proxy (the current deployment).
 */

interface Bucket {
  hits: number[]; // Unix timestamps (ms) of recent hits within the window
}

const _store = new Map<string, Bucket>();

// Prune the store periodically to prevent unbounded memory growth from stale keys.
// Fires every 10 minutes; removes buckets whose last hit was >1 hour ago.
setInterval(() => {
  const cutoff = Date.now() - 3_600_000;
  for (const [key, bucket] of _store) {
    if (!bucket.hits.length || bucket.hits[bucket.hits.length - 1] < cutoff) {
      _store.delete(key);
    }
  }
}, 600_000);

export interface RateLimitResult {
  allowed: boolean;
  /** Milliseconds until the oldest hit expires and a slot opens. 0 when allowed. */
  retryAfterMs: number;
}

/**
 * Check (and record) a hit for a given key.
 *
 * @param key       Unique bucket key — typically `${userId}:${endpoint}`
 * @param maxHits   Max hits allowed in the window
 * @param windowMs  Sliding window size in milliseconds
 */
export function checkRateLimit(
  key: string,
  maxHits: number,
  windowMs: number,
): RateLimitResult {
  const now = Date.now();
  let bucket = _store.get(key);
  if (!bucket) {
    bucket = { hits: [] };
    _store.set(key, bucket);
  }

  // Drop hits that have expired out of the window
  const cutoff = now - windowMs;
  bucket.hits = bucket.hits.filter((t) => t > cutoff);

  if (bucket.hits.length >= maxHits) {
    const retryAfterMs = windowMs - (now - bucket.hits[0]);
    return { allowed: false, retryAfterMs: Math.max(0, retryAfterMs) };
  }

  bucket.hits.push(now);
  return { allowed: true, retryAfterMs: 0 };
}
