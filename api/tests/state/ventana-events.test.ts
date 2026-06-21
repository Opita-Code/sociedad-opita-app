/**
 * Ventana events — append-only event log with 2 GSIs.
 *
 * Behaviors:
 *  - appendEvent writes to KEYS.ventanaEvent(iso, personaId) with:
 *      pk     = ENTITY#EVENT#<iso>
 *      sk     = <personaId>
 *      personaId = <personaId>     (for GSI1 byPersona hashKey)
 *      tsBucket = "yyyy-mm"        (for GSI2 byTime hashKey)
 *      ts     = <iso>              (for GSI2 byTime rangeKey)
 *  - getEventsByPersona(personaId, { since?, until?, limit? }) queries GSI1 byPersona
 *  - getEventsByTimeBucket(bucket, { since?, until?, limit? }) queries GSI2 byTime
 *  - tsBucket computed from ts field via tsBucket(iso)
 *  - Events sorted by ts DESCENDING by default (newest first)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { putItemMock, queryByPersonaMock, queryByTimeMock } = vi.hoisted(() => ({
  putItemMock: vi.fn(),
  queryByPersonaMock: vi.fn(),
  queryByTimeMock: vi.fn(),
}));

vi.mock("../../src/state/dynamo-client", () => ({
  putItem: putItemMock,
  queryByPersona: queryByPersonaMock,
  queryByTime: queryByTimeMock,
}));

import {
  appendEvent,
  getEventsByPersona,
  getEventsByTimeBucket,
} from "../../src/state/ventana-events";
import { KEYS, tsBucket } from "../../src/state/schema";

beforeEach(() => {
  putItemMock.mockReset();
  queryByPersonaMock.mockReset();
  queryByTimeMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

function putItemPayload() {
  return putItemMock.mock.calls[0]![0] as Record<string, unknown>;
}

describe("appendEvent()", () => {
  it("writes to KEYS.ventanaEvent(iso, personaId) with correct pk/sk", async () => {
    putItemMock.mockResolvedValueOnce(undefined);
    await appendEvent({
      ts: "2025-06-21T12:00:00Z",
      personaId: "don_rosalio",
      type: "tienda",
      description: "Abre la tienda",
    });
    const written = putItemPayload();
    expect(written.pk).toBe(
      KEYS.ventanaEvent("2025-06-21T12:00:00Z", "don_rosalio").pk,
    );
    expect(written.sk).toBe(
      KEYS.ventanaEvent("2025-06-21T12:00:00Z", "don_rosalio").sk,
    );
  });

  it("writes tsBucket = yyyy-mm from ts", async () => {
    putItemMock.mockResolvedValueOnce(undefined);
    await appendEvent({
      ts: "2025-06-21T12:00:00Z",
      personaId: "dona_rosa",
      type: "tienda",
      description: "Barre el andén",
    });
    const written = putItemPayload();
    expect(written.tsBucket).toBe("2025-06");
    expect(written.tsBucket).toBe(tsBucket("2025-06-21T12:00:00Z"));
  });

  it("preserves personaId (used by GSI1 hashKey)", async () => {
    putItemMock.mockResolvedValueOnce(undefined);
    await appendEvent({
      ts: "2025-06-21T12:00:00Z",
      personaId: "don_cecilio",
      type: "iglesia",
      description: "Enciende las velas",
    });
    const written = putItemPayload();
    expect(written.personaId).toBe("don_cecilio");
  });

  it("preserves ts (used by GSI2 rangeKey)", async () => {
    putItemMock.mockResolvedValueOnce(undefined);
    await appendEvent({
      ts: "2025-06-21T12:00:00Z",
      personaId: "p",
      type: "plaza",
      description: "x",
    });
    const written = putItemPayload();
    expect(written.ts).toBe("2025-06-21T12:00:00Z");
  });

  it("preserves type and description", async () => {
    putItemMock.mockResolvedValueOnce(undefined);
    await appendEvent({
      ts: "2025-06-21T12:00:00Z",
      personaId: "p",
      type: "finca",
      description: "Carga la mula",
    });
    const written = putItemPayload();
    expect(written.type).toBe("finca");
    expect(written.description).toBe("Carga la mula");
  });

  it("does NOT set expiresAt (events are durable)", async () => {
    putItemMock.mockResolvedValueOnce(undefined);
    await appendEvent({
      ts: "2025-06-21T12:00:00Z",
      personaId: "p",
      type: "otro",
      description: "x",
    });
    expect(putItemMock.mock.calls[0]!.length).toBe(1);
  });

  it("accepts all valid event types", async () => {
    const types = ["tienda", "iglesia", "plaza", "finca", "otro"] as const;
    for (const t of types) {
      putItemMock.mockResolvedValueOnce(undefined);
      await appendEvent({
        ts: "2025-06-21T12:00:00Z",
        personaId: "p",
        type: t,
        description: "x",
      });
      // Read the most recent call's payload (each iteration is a new call).
      const calls = putItemMock.mock.calls;
      const written = calls[calls.length - 1]![0] as Record<string, unknown>;
      expect(written.type).toBe(t);
    }
  });
});

describe("getEventsByPersona()", () => {
  it("queries GSI1 byPersona with personaId", async () => {
    queryByPersonaMock.mockResolvedValueOnce([]);
    await getEventsByPersona("don_rosalio");
    expect(queryByPersonaMock).toHaveBeenCalledTimes(1);
    const [pidArg] = queryByPersonaMock.mock.calls[0]!;
    expect(pidArg).toBe("don_rosalio");
  });

  it("supports since/until options (filters in memory after DDB query)", async () => {
    // GSI1 byPersona has rangeKey=sk (= personaId), not ts — so the time range
    // is applied after DDB returns the items. Verify the filter is enforced.
    queryByPersonaMock.mockResolvedValueOnce([
      {
        ts: "2025-05-31T23:59:59Z",
        personaId: "don_rosalio",
        type: "iglesia",
        description: "before window",
      },
      {
        ts: "2025-06-15T12:00:00Z",
        personaId: "don_rosalio",
        type: "tienda",
        description: "in window",
      },
      {
        ts: "2025-07-01T00:00:00Z",
        personaId: "don_rosalio",
        type: "finca",
        description: "after window",
      },
    ]);
    const result = await getEventsByPersona("don_rosalio", {
      since: "2025-06-01T00:00:00Z",
      until: "2025-06-30T23:59:59Z",
    });
    expect(result).toHaveLength(1);
    expect(result[0]!.ts).toBe("2025-06-15T12:00:00Z");
    expect(result[0]!.description).toBe("in window");
  });

  it("supports limit option", async () => {
    queryByPersonaMock.mockResolvedValueOnce([]);
    await getEventsByPersona("don_rosalio", { limit: 10 });
    const opts = queryByPersonaMock.mock.calls[0]![1] as Record<
      string,
      unknown
    >;
    expect(opts.limit).toBe(10);
  });

  it("returns array of events sorted by ts descending by default", async () => {
    queryByPersonaMock.mockResolvedValueOnce([
      { ts: "2025-06-21T13:00:00Z", personaId: "don_rosalio", type: "tienda" },
      { ts: "2025-06-21T12:00:00Z", personaId: "don_rosalio", type: "iglesia" },
    ]);
    const result = await getEventsByPersona("don_rosalio");
    expect(result).toHaveLength(2);
    expect(result[0]!.ts).toBe("2025-06-21T13:00:00Z");
  });

  it("returns empty array when no events", async () => {
    queryByPersonaMock.mockResolvedValueOnce([]);
    const result = await getEventsByPersona("nobody");
    expect(result).toEqual([]);
  });
});

describe("getEventsByTimeBucket()", () => {
  it("queries GSI2 byTime with tsBucket", async () => {
    queryByTimeMock.mockResolvedValueOnce([]);
    await getEventsByTimeBucket("2025-06");
    expect(queryByTimeMock).toHaveBeenCalledTimes(1);
    const [bucketArg] = queryByTimeMock.mock.calls[0]!;
    expect(bucketArg).toBe("2025-06");
  });

  it("supports since/until range options (mapped to tsGte/tsLte in DDB query)", async () => {
    queryByTimeMock.mockResolvedValueOnce([]);
    await getEventsByTimeBucket("2025-06", {
      since: "2025-06-15T00:00:00Z",
      until: "2025-06-21T23:59:59Z",
    });
    const opts = queryByTimeMock.mock.calls[0]![1] as Record<string, unknown>;
    // GSI2 byTime has rangeKey=ts, so we push the time range down to DDB.
    expect(opts).toMatchObject({
      tsGte: "2025-06-15T00:00:00Z",
      tsLte: "2025-06-21T23:59:59Z",
    });
  });

  it("supports limit option", async () => {
    queryByTimeMock.mockResolvedValueOnce([]);
    await getEventsByTimeBucket("2025-06", { limit: 50 });
    const opts = queryByTimeMock.mock.calls[0]![1] as Record<string, unknown>;
    expect(opts.limit).toBe(50);
  });

  it("returns events sorted by ts descending (newest first)", async () => {
    queryByTimeMock.mockResolvedValueOnce([
      { ts: "2025-06-21T15:00:00Z", personaId: "p3", type: "tienda" },
      { ts: "2025-06-21T12:00:00Z", personaId: "p1", type: "iglesia" },
      { ts: "2025-06-21T08:00:00Z", personaId: "p2", type: "plaza" },
    ]);
    const result = await getEventsByTimeBucket("2025-06");
    expect(result).toHaveLength(3);
    expect(result[0]!.ts).toBe("2025-06-21T15:00:00Z");
    expect(result[1]!.ts).toBe("2025-06-21T12:00:00Z");
    expect(result[2]!.ts).toBe("2025-06-21T08:00:00Z");
  });

  it("returns empty array when no events in bucket", async () => {
    queryByTimeMock.mockResolvedValueOnce([]);
    const result = await getEventsByTimeBucket("2099-12");
    expect(result).toEqual([]);
  });
});

describe("GSI key shape", () => {
  it("appended item satisfies byPersona (personaId + sk) and byTime (tsBucket + ts)", async () => {
    putItemMock.mockResolvedValueOnce(undefined);
    await appendEvent({
      ts: "2025-06-21T12:00:00Z",
      personaId: "don_emigdio",
      type: "finca",
      description: "Pela el banano",
    });
    const written = putItemPayload();
    expect(written.personaId).toBe("don_emigdio");
    expect(written.sk).toBe("don_emigdio");
    expect(written.tsBucket).toBe("2025-06");
    expect(written.ts).toBe("2025-06-21T12:00:00Z");
  });
});
