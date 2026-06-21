/**
 * Token bucket rate limiter — per-IP, in-memory.
 *
 * Phase 1 scope: per-Lambda-invocation state. Acceptable because:
 *   - Lambda concurrency per warm instance is serialized through the bucket map.
 *   - Cold-start resets the map (acceptable — it's a soft limiter, not a billing gate).
 *
 * For Phase 2+: swap the Map for DynamoDB conditional writes or Redis if we
 * need cross-instance rate coordination.
 *
 * Algorithm: classic token bucket.
 *   - capacity:           max tokens in the bucket (default 10)
 *   - refillRatePerSec:   tokens added per second (default 10/60 ≈ 0.1667 → 10/min)
 *   - On tryConsume(ip):  lazy refill since lastRefill, then decrement if tokens >= 1.
 *
 * Polish R9 (HIGH #2): a module-scope `dialogueRateLimiter` singleton
 * is now exported via `getDialogueRateLimiter()`. The dialogue handler
 * calls tryConsume() at the top of POST /v1/dialogue to cap a single
 * visitor at 10 requests/minute before any LLM work happens. Lazy
 * construction keeps cold-start cost identical for tests that never
 * touch the rate-limit surface.
 */
export interface TokenBucketConfig {
  capacity: number;
  refillRatePerSec: number;
}

// Default per-IP cap. 10 req/min is a soft cap: one visitor can do a
// short conversation burst but cannot drain the DeepSeek quota. Tuned
// to be loose enough for the chaos test (5-10 concurrent personas from
// one IP) and tight enough to blunt a script kiddie.
const DIALOGUE_DEFAULT_CAPACITY = 10;
const DIALOGUE_DEFAULT_REFILL_PER_SEC = 10 / 60; // 1 token every 6s

let dialogueRateLimiterSingleton: TokenBucket | null = null;

/**
 * Return the module-scope dialogue rate limiter. Lazy so test
 * suites that don't care about rate limits don't pay for it. The
 * singleton lives in module scope, so multiple handlers sharing it
 * (e.g., /v1/simulate and /v1/dialogue) see the same bucket map —
 * which is the right behavior for a per-IP visitor cap.
 */
export function getDialogueRateLimiter(): TokenBucket {
  if (!dialogueRateLimiterSingleton) {
    const cap = Number(process.env.RATE_LIMIT_CAPACITY) || DIALOGUE_DEFAULT_CAPACITY;
    const refill = Number(process.env.RATE_LIMIT_REFILL_PER_SEC) || DIALOGUE_DEFAULT_REFILL_PER_SEC;
    dialogueRateLimiterSingleton = new TokenBucket({
      capacity: cap,
      refillRatePerSec: refill,
    });
  }
  return dialogueRateLimiterSingleton;
}

interface BucketState {
  tokens: number;
  lastRefillMs: number;
}

export class TokenBucket {
  private readonly capacity: number;
  private readonly refillRatePerSec: number;
  private readonly buckets = new Map<string, BucketState>();

  constructor(config: TokenBucketConfig) {
    if (config.capacity < 0) throw new Error("capacity must be >= 0");
    if (config.refillRatePerSec < 0) throw new Error("refillRatePerSec must be >= 0");
    this.capacity = config.capacity;
    this.refillRatePerSec = config.refillRatePerSec;
  }

  tryConsume(ip: string): boolean {
    const now = Date.now();
    let state = this.buckets.get(ip);
    if (!state) {
      state = { tokens: this.capacity, lastRefillMs: now };
      this.buckets.set(ip, state);
    } else {
      const elapsedSec = (now - state.lastRefillMs) / 1000;
      const refilled = elapsedSec * this.refillRatePerSec;
      state.tokens = Math.min(this.capacity, state.tokens + refilled);
      state.lastRefillMs = now;
    }

    if (state.tokens >= 1) {
      state.tokens -= 1;
      return true;
    }
    return false;
  }

  /** Inspection helper — exposed for tests/observability only. */
  getTokens(ip: string): number {
    const state = this.buckets.get(ip);
    return state ? state.tokens : this.capacity;
  }

  /** Inspection helper — number of distinct IPs tracked. */
  size(): number {
    return this.buckets.size;
  }
}
