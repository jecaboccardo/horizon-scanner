/**
 * supabase/functions/_shared/qwenGate.ts
 *
 * Process-wide concurrency gate for the single Qwen 2.5-14b instance behind the
 * LiteLLM proxy. That model serves ONE GPU and serializes concurrent requests —
 * measured 2026-07-09: a call that runs alone finishes in ~3-5s, but 5 fired at
 * once degrade to 5-15s and blow the search-time retry-ladder timeouts.
 *
 * The fix is coordination, not more hardware: cap in-flight calls at a small N
 * so every request that RUNS sees a lightly-loaded GPU, and QUEUE the rest.
 *
 * DESIGN (no-degradation contract):
 *   - Everyone WAITS for a slot — callers never silently drop to a fallback just
 *     because the GPU is busy. Bursts are resequenced, not shed.
 *   - Two priorities. Interactive work (search facets, HyDE, chat) jumps ahead of
 *     BACKGROUND work (JEL section drafting, topicality segmentation). Background
 *     work fills the idle gaps between interactive bursts and always completes —
 *     it just yields the GPU to anything a user is actively waiting on.
 *   - The per-request timeout starts only AFTER a slot is acquired (see
 *     qwenClient.ts / jelPaperPipeline.callQwen), so queue wait never eats the
 *     request budget — the classic "wrap a semaphore, still times out" trap.
 *   - The acquire WAIT ceiling is a safety net for a WEDGED GPU, not a
 *     degradation trigger: under realistic load (a few analysts) the queue drains
 *     in well under the ceiling, so it never trips. If the GPU is genuinely dead,
 *     a bounded reject beats hanging the HTTP request until the proxy kills it.
 *
 * SCOPE: per deno-api process. There is one deno-api process, so this is global
 * for app traffic — but it does NOT bound the CT135 extraction worker or backfill
 * scripts, which hit the same proxy from other processes. The "no backfills while
 * prod is live" rule still stands.
 */

function readEnv(key: string): string | undefined {
  // deno-lint-ignore no-explicit-any
  const denoEnv = (globalThis as any).Deno?.env;
  if (denoEnv && typeof denoEnv.get === "function") return denoEnv.get(key) ?? undefined;
  // deno-lint-ignore no-explicit-any
  return (globalThis as any).process?.env?.[key];
}
function envInt(key: string, def: number): number {
  const v = Number(readEnv(key));
  return Number.isFinite(v) && v > 0 ? v : def;
}

// Tuned to the 2026-07-09 latency measurements: 2-way keeps each call ~5s;
// 3-way already pushes the slowest call past 9s. Env-overridable.
const MAX_CONCURRENCY = envInt("QWEN_MAX_CONCURRENCY", 2);
// Acquire-wait ceilings (safety net only — see header). Interactive callers have
// a user watching; background callers (JEL/topicality) can wait much longer.
const WAIT_INTERACTIVE_MS = envInt("QWEN_GATE_WAIT_MS", 60_000);
const WAIT_BACKGROUND_MS = envInt("QWEN_GATE_WAIT_BG_MS", 240_000);

export type Release = () => void;

export class QwenGateTimeoutError extends Error {
  constructor(public waitedMs: number, public background: boolean) {
    super(`qwen gate: no slot after ${waitedMs}ms (background=${background}) — GPU likely saturated or down`);
    this.name = "QwenGateTimeoutError";
  }
}

interface Waiter {
  priority: number; // 1 = interactive (served first), 0 = background
  seq: number; // FIFO tiebreak within a priority
  grant: () => boolean; // resolves the acquire promise; false if already settled
}

class PriorityGate {
  private inFlight = 0;
  private seq = 0;
  private readonly queue: Waiter[] = [];
  private peakQueue = 0;

  constructor(private readonly max: number) {}

  /** Acquire a slot. Resolves with a release fn once a slot is free; rejects with
   *  QwenGateTimeoutError only if the wait ceiling is hit (wedged GPU). */
  acquire(opts: { background?: boolean; waitMs?: number } = {}): Promise<Release> {
    const background = opts.background === true;
    const priority = background ? 0 : 1;
    const waitMs = opts.waitMs ?? (background ? WAIT_BACKGROUND_MS : WAIT_INTERACTIVE_MS);

    return new Promise<Release>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const w: Waiter = {
        priority,
        seq: this.seq++,
        grant: () => {
          if (settled) return false;
          settled = true;
          if (timer) clearTimeout(timer);
          resolve(this.makeRelease());
          return true;
        },
      };
      if (Number.isFinite(waitMs) && waitMs > 0) {
        timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          const idx = this.queue.indexOf(w);
          if (idx >= 0) this.queue.splice(idx, 1);
          reject(new QwenGateTimeoutError(waitMs, background));
        }, waitMs);
      }
      this.insert(w);
      if (this.queue.length > this.peakQueue) this.peakQueue = this.queue.length;
      this.pump();
    });
  }

  /** Insert keeping the queue ordered: higher priority first, FIFO within a priority. */
  private insert(w: Waiter): void {
    let i = this.queue.length;
    for (let k = 0; k < this.queue.length; k++) {
      if (this.queue[k].priority < w.priority) { i = k; break; }
    }
    this.queue.splice(i, 0, w);
  }

  /** Idempotent release — guards against a double-release decrementing twice
   *  (which would silently raise effective concurrency). */
  private makeRelease(): Release {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.inFlight--;
      this.pump();
    };
  }

  /** Grant slots to the front of the queue while capacity remains. Runs
   *  synchronously, so no timeout can interleave mid-pump. */
  private pump(): void {
    while (this.inFlight < this.max && this.queue.length > 0) {
      const w = this.queue.shift()!;
      if (w.grant()) this.inFlight++;
      // grant()===false only if the waiter already timed out (removed from queue
      // in its timer, so unreachable here); the guard is belt-and-suspenders.
    }
  }

  stats(): { max: number; inFlight: number; queued: number; peakQueue: number } {
    return { max: this.max, inFlight: this.inFlight, queued: this.queue.length, peakQueue: this.peakQueue };
  }
}

/** THE process-wide gate for Qwen 2.5-14b. Import this singleton everywhere the
 *  14b is called (qwenClient.qwenGenerate + jelPaperPipeline.callQwen). */
export const qwenGate = new PriorityGate(MAX_CONCURRENCY);
