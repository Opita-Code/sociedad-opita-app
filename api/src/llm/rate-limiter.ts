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
 */
export interface TokenBucketConfig {
  capacity: number;
  refillRatePerSec: number;
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
