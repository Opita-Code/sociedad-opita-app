/**
 * Persona state — tests FIRST (strict TDD).
 *
 * Behaviors:
 *  - getPersonaState returns defaults when not in DDB
 *  - getPersonaState returns stored state when found
 *  - setPersonaState writes to DDB at KEYS.personaState(personaId)
 *  - Default state: emotionalState="neutral", lastSeen=epoch 0 (1970-01-01T00:00:00Z)
 *  - Recent events: max 5, FIFO eviction (newest at end)
 *  - Default networkPosition: { betweenness: 0, degree: 0 }
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { getItemMock, putItemMock } = vi.hoisted(() => ({
  getItemMock: vi.fn(),
  putItemMock: vi.fn(),
}));

vi.mock("../../src/state/dynamo-client", () => ({
  getItem: getItemMock,
  putItem: putItemMock,
}));

import {
  getPersonaState,
  setPersonaState,
  defaultPersonaState,
} from "../../src/state/persona-state";
import { KEYS } from "../../src/state/schema";

beforeEach(() => {
  getItemMock.mockReset();
  putItemMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("defaultPersonaState()", () => {
  it("returns a fresh default state with given personaId", () => {
    const s = defaultPersonaState("don_rosalio");
    expect(s.personaId).toBe("don_rosalio");
    expect(s.emotionalState).toBe("neutral");
    expect(s.recentEvents).toEqual([]);
    expect(s.lastSeen).toBe("1970-01-01T00:00:00Z");
    expect(s.networkPosition).toEqual({ betweenness: 0, degree: 0 });
  });

  it("returns an independent object on each call (no shared mutation)", () => {
    const a = defaultPersonaState("p1");
    const b = defaultPersonaState("p2");
    a.recentEvents.push("evt-1");
    expect(b.recentEvents).toEqual([]);
    expect(a.networkPosition).not.toBe(b.networkPosition);
  });
});

describe("getPersonaState()", () => {
  it("queries DDB at KEYS.personaState(personaId)", async () => {
    getItemMock.mockResolvedValueOnce(null);
    await getPersonaState("don_rosalio");
    expect(getItemMock).toHaveBeenCalledWith(
      KEYS.personaState("don_rosalio").pk,
      KEYS.personaState("don_rosalio").sk,
    );
  });

  it("returns default state when DDB has no item", async () => {
    getItemMock.mockResolvedValueOnce(null);
    const result = await getPersonaState("nobody");
    expect(result).toEqual(defaultPersonaState("nobody"));
  });

  it("returns stored state when present", async () => {
    const stored = {
      personaId: "don_rosalio",
      emotionalState: "happy",
      recentEvents: ["evt-1", "evt-2"],
      lastSeen: "2025-06-21T12:00:00Z",
      networkPosition: { betweenness: 0.5, degree: 12 },
    };
    getItemMock.mockResolvedValueOnce(stored);
    const result = await getPersonaState("don_rosalio");
    expect(result).toEqual(stored);
    expect(result.emotionalState).toBe("happy");
    expect(result.recentEvents).toHaveLength(2);
  });

  it("preserves all fields returned from DDB", async () => {
    getItemMock.mockResolvedValueOnce({
      personaId: "dona_rosa",
      emotionalState: "anxious",
      recentEvents: ["a", "b", "c", "d", "e"],
      lastSeen: "2026-01-15T08:00:00Z",
      networkPosition: { betweenness: 0.9, degree: 42 },
    });
    const result = await getPersonaState("dona_rosa");
    expect(result.networkPosition.betweenness).toBe(0.9);
    expect(result.recentEvents).toHaveLength(5);
  });
});

describe("setPersonaState()", () => {
  it("writes a complete state to DDB at KEYS.personaState(personaId)", async () => {
    putItemMock.mockResolvedValueOnce(undefined);
    await setPersonaState("don_rosalio", {
      emotionalState: "sad",
      recentEvents: ["evt-99"],
      lastSeen: "2025-06-21T12:00:00Z",
      networkPosition: { betweenness: 0.42, degree: 8 },
    });
    expect(putItemMock).toHaveBeenCalledTimes(1);
    const written = putItemMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(written).toMatchObject({
      pk: KEYS.personaState("don_rosalio").pk,
      sk: KEYS.personaState("don_rosalio").sk,
      personaId: "don_rosalio",
      emotionalState: "sad",
      recentEvents: ["evt-99"],
      lastSeen: "2025-06-21T12:00:00Z",
    });
    expect((written.networkPosition as { betweenness: number }).betweenness).toBe(
      0.42,
    );
  });

  it("merges partial updates into the current state", async () => {
    getItemMock.mockResolvedValueOnce({
      personaId: "don_rosalio",
      emotionalState: "neutral",
      recentEvents: ["evt-old-1", "evt-old-2"],
      lastSeen: "2025-01-01T00:00:00Z",
      networkPosition: { betweenness: 0.5, degree: 10 },
    });
    putItemMock.mockResolvedValueOnce(undefined);
    await setPersonaState("don_rosalio", {
      emotionalState: "happy",
      lastSeen: "2025-06-21T12:00:00Z",
    });
    const written = putItemMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(written.emotionalState).toBe("happy");
    expect(written.lastSeen).toBe("2025-06-21T12:00:00Z");
    expect(written.recentEvents).toEqual(["evt-old-1", "evt-old-2"]);
    expect(written.networkPosition).toEqual({ betweenness: 0.5, degree: 10 });
  });

  it("does NOT set expiresAt (persona state is durable)", async () => {
    putItemMock.mockResolvedValueOnce(undefined);
    await setPersonaState("don_rosalio", {
      emotionalState: "happy",
      recentEvents: [],
      lastSeen: "2025-06-21T12:00:00Z",
      networkPosition: { betweenness: 0, degree: 0 },
    });
    const options = putItemMock.mock.calls[0]![1] as
      | { ttl?: number }
      | undefined;
    expect(options?.ttl).toBeUndefined();
  });
});

describe("setPersonaState() — recentEvents FIFO (max 5)", () => {
  it("appends event when under the cap", async () => {
    getItemMock.mockResolvedValueOnce({
      personaId: "p",
      emotionalState: "neutral",
      recentEvents: ["a", "b"],
      lastSeen: "2025-01-01T00:00:00Z",
      networkPosition: { betweenness: 0, degree: 0 },
    });
    putItemMock.mockResolvedValueOnce(undefined);
    await setPersonaState("p", {
      emotionalState: "neutral",
      lastSeen: "2025-06-21T12:00:00Z",
      networkPosition: { betweenness: 0, degree: 0 },
      recentEvents: ["a", "b", "c"],
    });
    const written = putItemMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(written.recentEvents).toEqual(["a", "b", "c"]);
  });

  it("evicts oldest when going from 5 to 6 (FIFO, newest at end)", async () => {
    getItemMock.mockResolvedValueOnce({
      personaId: "p",
      emotionalState: "neutral",
      recentEvents: ["e1", "e2", "e3", "e4", "e5"],
      lastSeen: "2025-01-01T00:00:00Z",
      networkPosition: { betweenness: 0, degree: 0 },
    });
    putItemMock.mockResolvedValueOnce(undefined);
    await setPersonaState("p", {
      emotionalState: "neutral",
      lastSeen: "2025-06-21T12:00:00Z",
      networkPosition: { betweenness: 0, degree: 0 },
      recentEvents: ["e1", "e2", "e3", "e4", "e5", "e6"],
    });
    const written = putItemMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(written.recentEvents).toEqual(["e2", "e3", "e4", "e5", "e6"]);
    expect((written.recentEvents as string[]).length).toBe(5);
  });

  it("handles empty existing state correctly", async () => {
    getItemMock.mockResolvedValueOnce({
      personaId: "p",
      emotionalState: "neutral",
      recentEvents: [],
      lastSeen: "1970-01-01T00:00:00Z",
      networkPosition: { betweenness: 0, degree: 0 },
    });
    putItemMock.mockResolvedValueOnce(undefined);
    await setPersonaState("p", {
      emotionalState: "neutral",
      lastSeen: "2025-06-21T12:00:00Z",
      networkPosition: { betweenness: 0, degree: 0 },
      recentEvents: ["first"],
    });
    const written = putItemMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(written.recentEvents).toEqual(["first"]);
  });
});

describe("getPersonaState() — defensive defaults", () => {
  it("returns defaults if DDB returns undefined Item fields", async () => {
    getItemMock.mockResolvedValueOnce({});
    const result = await getPersonaState("ghost");
    expect(result.personaId).toBe("ghost");
    expect(result.emotionalState).toBe("neutral");
    expect(result.recentEvents).toEqual([]);
    expect(result.lastSeen).toBe("1970-01-01T00:00:00Z");
  });
});
