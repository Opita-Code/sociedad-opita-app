import { describe, it, expect } from "vitest";
import {
  pk,
  sk,
  tsBucket,
  convTtlEpoch,
  KEYS,
  CONV_TTL_DAYS,
  ENTITY_PREFIX,
  TABLE_NAME_ENV,
  DEFAULT_TABLE,
  type EntityType,
  type PersonaState,
  type ConversationTurn,
  type VentanaEvent,
} from "../../src/state/schema";

describe("schema constants", () => {
  it("exports ENTITY_PREFIX = 'ENTITY#'", () => {
    expect(ENTITY_PREFIX).toBe("ENTITY#");
  });

  it("exports TABLE_NAME_ENV = 'DDB_TABLE'", () => {
    expect(TABLE_NAME_ENV).toBe("DDB_TABLE");
  });

  it("exports DEFAULT_TABLE = 'SociedadOpitaState'", () => {
    expect(DEFAULT_TABLE).toBe("SociedadOpitaState");
  });

  it("exports CONV_TTL_DAYS = 90", () => {
    expect(CONV_TTL_DAYS).toBe(90);
  });
});

describe("pk()", () => {
  it("builds pk for PERSONA entity", () => {
    expect(pk("PERSONA", "don_rosalio_ganadero")).toBe(
      "ENTITY#PERSONA#don_rosalio_ganadero",
    );
  });

  it("builds pk for CONV entity", () => {
    expect(pk("CONV", "conv-abc-123")).toBe("ENTITY#CONV#conv-abc-123");
  });

  it("builds pk for EVENT entity", () => {
    expect(pk("EVENT", "evt-xyz-789")).toBe("ENTITY#EVENT#evt-xyz-789");
  });

  it("uses ENTITY_PREFIX constant", () => {
    const id = "x";
    expect(pk("PERSONA", id).startsWith(ENTITY_PREFIX)).toBe(true);
  });

  it("accepts all EntityType values without runtime error", () => {
    const types: EntityType[] = ["PERSONA", "CONV", "EVENT"];
    for (const t of types) {
      expect(pk(t, "id")).toBe(`ENTITY#${t}#id`);
    }
  });
});

describe("sk()", () => {
  it("returns the subkey verbatim when no suffix", () => {
    expect(sk("STATE")).toBe("STATE");
  });

  it("returns subkey#suffix when suffix provided", () => {
    expect(sk("MSG", "2025-06-21T12:00:00.000Z")).toBe(
      "MSG#2025-06-21T12:00:00.000Z",
    );
  });

  it("handles empty suffix by treating it as no suffix", () => {
    expect(sk("STATE", "")).toBe("STATE");
  });
});

describe("tsBucket()", () => {
  it("returns yyyy-mm prefix of ISO timestamp", () => {
    expect(tsBucket("2025-06-21T12:00:00Z")).toBe("2025-06");
  });

  it("handles January correctly", () => {
    expect(tsBucket("2026-01-01T00:00:00Z")).toBe("2026-01");
  });

  it("handles December correctly", () => {
    expect(tsBucket("2025-12-31T23:59:59Z")).toBe("2025-12");
  });

  it("works on ISO with milliseconds", () => {
    expect(tsBucket("2025-06-21T12:00:00.000Z")).toBe("2025-06");
  });
});

describe("convTtlEpoch()", () => {
  it("returns now + 90 days in epoch seconds (default Date.now())", () => {
    const before = Math.floor(Date.now() / 1000);
    const ttl = convTtlEpoch();
    const after = Math.floor(Date.now() / 1000);
    // 90 days in seconds = 7,776,000
    const expected = 7_776_000;
    expect(ttl).toBeGreaterThanOrEqual(before + expected);
    expect(ttl).toBeLessThanOrEqual(after + expected);
  });

  it("accepts a custom now parameter (ms)", () => {
    const nowMs = 1_700_000_000_000; // arbitrary fixed ms timestamp
    const expected = Math.floor(nowMs / 1000) + 90 * 24 * 60 * 60;
    expect(convTtlEpoch(nowMs)).toBe(expected);
  });

  it("equals CONV_TTL_DAYS * 86400 added to epoch seconds of now", () => {
    const nowMs = 1_725_000_000_000;
    const ttl = convTtlEpoch(nowMs);
    const expected = Math.floor(nowMs / 1000) + CONV_TTL_DAYS * 86_400;
    expect(ttl).toBe(expected);
  });

  it("90 days is exactly 7,776,000 seconds", () => {
    expect(CONV_TTL_DAYS * 86_400).toBe(7_776_000);
  });
});

describe("KEYS.personaState()", () => {
  it("returns ENTITY#PERSONA#<id> + STATE", () => {
    expect(KEYS.personaState("don_rosalio")).toEqual({
      pk: "ENTITY#PERSONA#don_rosalio",
      sk: "STATE",
    });
  });
});

describe("KEYS.conversationMessage()", () => {
  it("returns ENTITY#CONV#<convId> + MSG#<iso>", () => {
    expect(KEYS.conversationMessage("conv-1", "2025-06-21T12:00:00Z")).toEqual({
      pk: "ENTITY#CONV#conv-1",
      sk: "MSG#2025-06-21T12:00:00Z",
    });
  });
});

describe("KEYS.ventanaEvent()", () => {
  it("returns ENTITY#EVENT#<iso> + personaId", () => {
    expect(KEYS.ventanaEvent("2025-06-21T12:00:00Z", "don_rosalio")).toEqual({
      pk: "ENTITY#EVENT#2025-06-21T12:00:00Z",
      sk: "don_rosalio",
    });
  });
});

describe("type definitions (compile-time)", () => {
  it("PersonaState has required fields with correct types", () => {
    const state: PersonaState = {
      personaId: "don_rosalio",
      emotionalState: "happy",
      recentEvents: ["evt-1", "evt-2"],
      lastSeen: "2025-06-21T12:00:00Z",
      networkPosition: { betweenness: 0.42, degree: 12 },
    };
    expect(state.personaId).toBe("don_rosalio");
    expect(state.emotionalState).toBe("happy");
    expect(state.recentEvents).toHaveLength(2);
    expect(state.networkPosition.betweenness).toBeGreaterThan(0);
  });

  it("ConversationTurn has required fields", () => {
    const turn: ConversationTurn = {
      convId: "conv-1",
      ts: "2025-06-21T12:00:00Z",
      role: "user",
      content: "Hola",
    };
    expect(turn.role).toBe("user");
  });

  it("ConversationTurn role accepts both 'user' and 'persona'", () => {
    const user: ConversationTurn = {
      convId: "c",
      ts: "2025-06-21T12:00:00Z",
      role: "user",
      content: "x",
    };
    const persona: ConversationTurn = {
      convId: "c",
      ts: "2025-06-21T12:00:00Z",
      role: "persona",
      personaId: "don_rosalio",
      content: "y",
    };
    expect([user.role, persona.role]).toEqual(["user", "persona"]);
  });

  it("VentanaEvent has required fields", () => {
    const event: VentanaEvent = {
      ts: "2025-06-21T12:00:00Z",
      personaId: "don_rosalio",
      type: "tienda",
      description: "Abre la tienda",
    };
    expect(event.type).toBe("tienda");
  });

  it("VentanaEvent type accepts all valid location types", () => {
    const types: VentanaEvent["type"][] = [
      "tienda",
      "iglesia",
      "plaza",
      "finca",
      "otro",
    ];
    for (const t of types) {
      const event: VentanaEvent = {
        ts: "2025-06-21T12:00:00Z",
        personaId: "p",
        type: t,
        description: "d",
      };
      expect(event.type).toBe(t);
    }
  });

  it("PersonaState emotionalState accepts all valid states", () => {
    const states: PersonaState["emotionalState"][] = [
      "neutral",
      "happy",
      "sad",
      "angry",
      "anxious",
    ];
    for (const s of states) {
      const state: PersonaState = {
        personaId: "p",
        emotionalState: s,
        recentEvents: [],
        lastSeen: "1970-01-01T00:00:00Z",
        networkPosition: { betweenness: 0, degree: 0 },
      };
      expect(state.emotionalState).toBe(s);
    }
  });
});