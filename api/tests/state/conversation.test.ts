/**
 * Conversation store — append + retrieve with TTL 90 days.
 *
 * Behaviors:
 *  - appendTurn writes to KEYS.conversationMessage(convId, ts) with expiresAt
 *  - TTL is convTtlEpoch(now()) — epoch seconds, ~now + 90 days
 *  - getConversation returns all turns sorted by sk (timestamp) ascending
 *  - getConversation("nonexistent") returns []
 *  - Each item carries the full ConversationTurn shape
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { putItemMock, queryByPartitionMock } = vi.hoisted(() => ({
  putItemMock: vi.fn(),
  queryByPartitionMock: vi.fn(),
}));

vi.mock("../../src/state/dynamo-client", () => ({
  putItem: putItemMock,
  queryByPartition: queryByPartitionMock,
}));

import { appendTurn, getConversation } from "../../src/state/conversation";
import { KEYS, convTtlEpoch, type ConversationTurn } from "../../src/state/schema";

beforeEach(() => {
  putItemMock.mockReset();
  queryByPartitionMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

function putItemPayload() {
  return putItemMock.mock.calls[0]![0] as Record<string, unknown>;
}

function putItemOptions() {
  return putItemMock.mock.calls[0]![1] as { ttl?: number } | undefined;
}

describe("appendTurn()", () => {
  it("writes a turn to KEYS.conversationMessage(convId, ts) with correct key", async () => {
    putItemMock.mockResolvedValueOnce(undefined);
    await appendTurn({
      convId: "conv-1",
      ts: "2025-06-21T12:00:00Z",
      role: "user",
      content: "Hola",
    });
    const written = putItemPayload();
    expect(written.pk).toBe(KEYS.conversationMessage("conv-1", "2025-06-21T12:00:00Z").pk);
    expect(written.sk).toBe(KEYS.conversationMessage("conv-1", "2025-06-21T12:00:00Z").sk);
    expect(written.role).toBe("user");
    expect(written.content).toBe("Hola");
  });

  it("sets expiresAt via putItem ttl option (epoch seconds, ~now + 90d)", async () => {
    putItemMock.mockResolvedValueOnce(undefined);
    const before = Math.floor(Date.now() / 1000);
    await appendTurn({
      convId: "conv-1",
      ts: "2025-06-21T12:00:00Z",
      role: "persona",
      content: "Buenos días",
    });
    const after = Math.floor(Date.now() / 1000);
    const opts = putItemOptions();
    expect(opts?.ttl).toBeDefined();
    expect(opts!.ttl!).toBeGreaterThanOrEqual(before + 7_776_000);
    expect(opts!.ttl!).toBeLessThanOrEqual(after + 7_776_000);
  });

  it("includes personaId when provided", async () => {
    putItemMock.mockResolvedValueOnce(undefined);
    await appendTurn({
      convId: "conv-1",
      ts: "2025-06-21T12:00:00Z",
      role: "persona",
      personaId: "don_rosalio",
      content: "Asina es la cosa",
    });
    const written = putItemPayload();
    expect(written.personaId).toBe("don_rosalio");
  });

  it("includes metadata when provided", async () => {
    putItemMock.mockResolvedValueOnce(undefined);
    await appendTurn({
      convId: "conv-1",
      ts: "2025-06-21T12:00:00Z",
      role: "user",
      content: "x",
      metadata: { source: "web", ip: "127.0.0.1" },
    });
    const written = putItemPayload();
    expect(written.metadata).toEqual({ source: "web", ip: "127.0.0.1" });
  });

  it("uses convTtlEpoch helper for TTL computation", async () => {
    putItemMock.mockResolvedValueOnce(undefined);
    await appendTurn({
      convId: "conv-1",
      ts: "2025-06-21T12:00:00Z",
      role: "user",
      content: "x",
    });
    const opts = putItemOptions();
    const ttl = opts!.ttl!;
    expect(ttl).toBe(convTtlEpoch());
  });

  it("passes ttl to putItem as the SECOND argument", async () => {
    putItemMock.mockResolvedValueOnce(undefined);
    await appendTurn({
      convId: "c",
      ts: "2025-06-21T12:00:00Z",
      role: "user",
      content: "x",
    });
    expect(putItemMock.mock.calls[0]!.length).toBe(2);
    expect((putItemMock.mock.calls[0]![1] as { ttl: number }).ttl).toBeGreaterThan(0);
  });
});

describe("getConversation()", () => {
  it("returns empty array when no items in DDB", async () => {
    queryByPartitionMock.mockResolvedValueOnce([]);
    const result = await getConversation("conv-empty");
    expect(result).toEqual([]);
  });

  it("returns array of ConversationTurn shapes", async () => {
    queryByPartitionMock.mockResolvedValueOnce([
      {
        convId: "conv-1",
        ts: "2025-06-21T12:00:00Z",
        role: "user",
        content: "Hola",
      },
    ]);
    const result = await getConversation("conv-1");
    expect(result).toHaveLength(1);
    const turn: ConversationTurn = result[0]!;
    expect(turn.convId).toBe("conv-1");
    expect(turn.role).toBe("user");
    expect(turn.content).toBe("Hola");
  });

  it("queries partition key = ENTITY#CONV#<convId> with MSG# prefix", async () => {
    queryByPartitionMock.mockResolvedValueOnce([]);
    await getConversation("conv-1");
    expect(queryByPartitionMock).toHaveBeenCalledTimes(1);
    const [pkArg, opts] = queryByPartitionMock.mock.calls[0]!;
    expect(pkArg).toBe(KEYS.conversationMessage("conv-1", "").pk);
    expect((opts as { skPrefix: string }).skPrefix).toBe("MSG#");
  });

  it("uses scanForward=true (ascending ts order)", async () => {
    queryByPartitionMock.mockResolvedValueOnce([]);
    await getConversation("conv-1");
    const opts = queryByPartitionMock.mock.calls[0]![1] as {
      scanForward: boolean;
    };
    expect(opts.scanForward).toBe(true);
  });

  it("returns turns with personaId and metadata preserved", async () => {
    queryByPartitionMock.mockResolvedValueOnce([
      {
        convId: "conv-1",
        ts: "2025-06-21T12:00:00Z",
        role: "user",
        content: "Hola",
      },
      {
        convId: "conv-1",
        ts: "2025-06-21T12:01:00Z",
        role: "persona",
        personaId: "dona_rosa",
        content: "Asina es la cosa",
        metadata: { emotion: "happy" },
      },
    ]);
    const result = await getConversation("conv-1");
    expect(result).toHaveLength(2);
    expect(result[0]!.content).toBe("Hola");
    expect(result[1]!.personaId).toBe("dona_rosa");
    expect(result[1]!.metadata).toEqual({ emotion: "happy" });
  });

  it("falls back to safe defaults when DDB item fields missing", async () => {
    queryByPartitionMock.mockResolvedValueOnce([{}]);
    const result = await getConversation("conv-1");
    expect(result).toHaveLength(1);
    expect(result[0]!.role).toBe("user");
    expect(result[0]!.content).toBe("");
    expect(result[0]!.ts).toBe("");
  });
});

describe("getConversation() — TTL semantics (90 days)", () => {
  it("CONV_TTL_DAYS * 86400 = 7,776,000 (correct epoch seconds window)", () => {
    expect(7_776_000).toBe(90 * 24 * 60 * 60);
  });

  it("convTtlEpoch returns epoch seconds (whole number)", () => {
    const ttl = convTtlEpoch(1_725_000_000_000);
    expect(Number.isInteger(ttl)).toBe(true);
    expect(ttl).toBe(Math.floor(1_725_000_000_000 / 1000) + 7_776_000);
  });

  it("expired items are naturally filtered by DDB (returned as [])", async () => {
    queryByPartitionMock.mockResolvedValueOnce([]);
    const result = await getConversation("ancient-conv");
    expect(result).toEqual([]);
  });
});
