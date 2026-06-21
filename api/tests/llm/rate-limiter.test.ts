import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { TokenBucket } from "../../src/llm/rate-limiter";

describe("TokenBucket", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows up to `capacity` invocations in the initial window", () => {
    const bucket = new TokenBucket({ capacity: 10, refillRatePerSec: 10 / 60 });
    for (let i = 0; i < 10; i++) {
      expect(bucket.tryConsume("user1")).toBe(true);
    }
  });

  it("blocks the 11th invocation inside the same window", () => {
    const bucket = new TokenBucket({ capacity: 10, refillRatePerSec: 10 / 60 });
    for (let i = 0; i < 10; i++) bucket.tryConsume("user1");
    expect(bucket.tryConsume("user1")).toBe(false);
  });

  it("refills one token every 6s at 10/min (capacity 10)", () => {
    const bucket = new TokenBucket({ capacity: 10, refillRatePerSec: 10 / 60 });
    for (let i = 0; i < 10; i++) bucket.tryConsume("user1");
    expect(bucket.tryConsume("user1")).toBe(false);

    vi.advanceTimersByTime(6_000);
    expect(bucket.tryConsume("user1")).toBe(true);
    expect(bucket.tryConsume("user1")).toBe(false);
  });

  it("refills up to capacity, not beyond", () => {
    const bucket = new TokenBucket({ capacity: 5, refillRatePerSec: 1 });
    expect(bucket.tryConsume("u")).toBe(true);
    vi.advanceTimersByTime(60_000); // 60 tokens-worth of time
    // Still capped at capacity (5) — should be able to consume 5, then blocked.
    for (let i = 0; i < 5; i++) expect(bucket.tryConsume("u")).toBe(true);
    expect(bucket.tryConsume("u")).toBe(false);
  });

  it("isolates buckets per IP (different IPs do not share tokens)", () => {
    const bucket = new TokenBucket({ capacity: 10, refillRatePerSec: 10 / 60 });
    for (let i = 0; i < 10; i++) bucket.tryConsume("user1");
    expect(bucket.tryConsume("user1")).toBe(false);
    // user2 starts fresh
    expect(bucket.tryConsume("user2")).toBe(true);
  });

  it("returns false for a never-seen IP if capacity is 0 (degenerate)", () => {
    const bucket = new TokenBucket({ capacity: 0, refillRatePerSec: 0 });
    expect(bucket.tryConsume("nobody")).toBe(false);
  });
});
