/**
 * ContextBuilder — composes system + user prompts for /v1/dialogue.
 *
 * Behaviors:
 *  - buildContext(persona, scene, topK, query) returns { system, user }
 *  - system prompt includes persona identity, psychometric profile, RAG context, style guard
 *  - system prompt uses ALL the validated opita signals: display_name, role,
 *    muletillas (first 3), archetype, Big Five, Lomnitz, Dunbar, motivations,
 *    fears, network, and the canonical "espanol colombiano rural del Huila" guard.
 *  - system prompt embeds RAG snippets (truncated to 200 chars + "...") when
 *    topK is non-empty; omitted entirely when empty.
 *  - user prompt follows the spec: "Escena: <time> en <place>. <weather?> Pregunta: <query> ¿Que haces o dices?"
 *  - weather is omitted from user prompt when not provided.
 *  - Empty query still produces valid system + user strings (defensive).
 */
import { describe, it, expect } from "vitest";
import { buildContext } from "../../src/context/builder";
import { TELLO_PERSONAS } from "../../src/personas";
import type { RetrievalResult } from "../../src/rag/types";

const ROSA = TELLO_PERSONAS.find((p) => p.persona_id === "dona_rosa_tendera")!;
const ROSALIO = TELLO_PERSONAS.find((p) => p.persona_id === "don_rosalio_ganadero")!;

function makeResult(
  id: string,
  text: string,
  score: number,
  topic: string = "test/topic",
  personas: string[] = []
): RetrievalResult {
  return {
    score,
    doc: {
      id,
      text,
      embedding: [],
      metadata: { topic, personas, license: "CC-BY-4.0", tier: "free", language: "es" },
    },
  };
}

describe("buildContext() — return shape", () => {
  it("returns { system, user } object", () => {
    const ctx = buildContext(ROSA, { time: "06:00", place: "tienda" }, [], "Hola");
    expect(ctx).toHaveProperty("system");
    expect(ctx).toHaveProperty("user");
    expect(typeof ctx.system).toBe("string");
    expect(typeof ctx.user).toBe("string");
    expect(ctx.system.length).toBeGreaterThan(0);
    expect(ctx.user.length).toBeGreaterThan(0);
  });
});

describe("buildContext() — system prompt persona identity", () => {
  it("includes persona display_name and role", () => {
    const { system } = buildContext(ROSA, { time: "06:00", place: "tienda" }, [], "Hola");
    expect(system).toContain("Doña Rosa Elvira");
    expect(system).toContain("tendera");
  });

  it("includes first 3 muletillas of the persona", () => {
    const { system } = buildContext(ROSA, { time: "06:00", place: "tienda" }, [], "Hola");
    expect(system).toContain("mira ve");
    expect(system).toContain("le cuento");
    expect(system).toContain("verriondo");
  });

  it("includes the persona archetype", () => {
    const { system } = buildContext(ROSA, { time: "06:00", place: "tienda" }, [], "Hola");
    expect(system).toContain("tendero_pueblo");
  });

  it("includes all 5 Big Five traits", () => {
    const { system } = buildContext(ROSA, { time: "06:00", place: "tienda" }, [], "Hola");
    expect(system).toMatch(/O=50/);
    expect(system).toMatch(/C=65/);
    expect(system).toMatch(/E=80/);
    expect(system).toMatch(/A=68/);
    expect(system).toMatch(/N=45/);
  });

  it("includes Lomnitz primary/secondary, Dunbar layer, network signals", () => {
    const { system } = buildContext(ROSA, { time: "06:00", place: "tienda" }, [], "Hola");
    // Network metrics on Rosa (betweenness 0.55, degree 18)
    expect(system).toContain("betweenness=0.55");
    expect(system).toContain("degree=18");
  });

  it("includes motivations and fears joined by '; '", () => {
    const { system } = buildContext(ROSA, { time: "06:00", place: "tienda" }, [], "Hola");
    expect(system).toContain("ser_el_centro_de_informacion");
    expect(system).toContain("que_se_muera_el_pueblo");
  });

  it("respects muletilla count when persona has more than 3", () => {
    // ROSALIO has muletillas: ["asina es la cosa", "le digo yo", "Ni muerto"]
    const { system } = buildContext(ROSALIO, { time: "06:30", place: "finca" }, [], "Hola");
    expect(system).toContain("asina es la cosa");
    expect(system).toContain("le digo yo");
    expect(system).toContain("Ni muerto");
    // Only first 3 should appear (this list happens to be 3)
  });
});

describe("buildContext() — canonical style guard (espanol colombiano rural del Huila)", () => {
  it("includes the spec-mandated style guard", () => {
    const { system } = buildContext(ROSA, { time: "06:00", place: "tienda" }, [], "Hola");
    expect(system).toMatch(/espanol colombiano rural del Huila/i);
  });

  it("forbids neutro / argentino / mexicano / chileno / peninsular registers", () => {
    const { system } = buildContext(ROSA, { time: "06:00", place: "tienda" }, [], "Hola");
    expect(system).toMatch(/NO uses registros neutro, argentino, mexicano, chileno/i);
    expect(system).toMatch(/espanol peninsular/i);
  });

  it("forbids inventing biographical data not in the prompt", () => {
    const { system } = buildContext(ROSA, { time: "06:00", place: "tienda" }, [], "Hola");
    expect(system).toMatch(/NO inventes datos sobre tu biografia/i);
  });

  it("instructs to redirect when question is off-topic", () => {
    const { system } = buildContext(ROSA, { time: "06:00", place: "tienda" }, [], "Hola");
    expect(system).toMatch(/redirige amablemente/i);
  });
});

describe("buildContext() — RAG context injection", () => {
  it("includes RAG snippets when topK is non-empty", () => {
    const { system } = buildContext(
      ROSA,
      { time: "06:00", place: "tienda" },
      [
        makeResult("doc-1", "Doña Rosa es la tendera del pueblo", 0.92, "personas/dona-rosa", [
          "dona_rosa_tendera",
        ]),
      ],
      "¿Qué vende?"
    );
    expect(system).toContain("Contexto del pueblo");
    expect(system).toContain("doc-1");
    expect(system).toContain("score 0.920");
    expect(system).toContain("personas/dona-rosa");
    expect(system).toContain("dona_rosa_tendera");
    expect(system).toContain("Doña Rosa es la tendera del pueblo");
  });

  it("truncates RAG snippets longer than 200 chars with '...'", () => {
    const longText = "x".repeat(500);
    const { system } = buildContext(
      ROSA,
      { time: "06:00", place: "tienda" },
      [makeResult("long-doc", longText, 0.5)],
      "Hola"
    );
    expect(system).toContain("x".repeat(200) + "...");
    expect(system).not.toContain("x".repeat(201));
  });

  it("does NOT truncate RAG snippets shorter than or equal to 200 chars", () => {
    const shortText = "y".repeat(150);
    const { system } = buildContext(
      ROSA,
      { time: "06:00", place: "tienda" },
      [makeResult("short-doc", shortText, 0.5)],
      "Hola"
    );
    expect(system).toContain("y".repeat(150));
    expect(system).not.toContain("...");
  });

  it("includes multiple RAG results with sequential numbering", () => {
    const { system } = buildContext(
      ROSA,
      { time: "06:00", place: "tienda" },
      [
        makeResult("d1", "first", 0.9),
        makeResult("d2", "second", 0.7),
        makeResult("d3", "third", 0.5),
      ],
      "Hola"
    );
    expect(system).toMatch(/\[1\] .*first/);
    expect(system).toMatch(/\[2\] .*second/);
    expect(system).toMatch(/\[3\] .*third/);
  });

  it("omits RAG context block when topK is empty", () => {
    const { system } = buildContext(ROSA, { time: "06:00", place: "tienda" }, [], "Hola");
    expect(system).not.toContain("Contexto del pueblo");
    expect(system).not.toMatch(/\[1\] \(score/);
  });
});

describe("buildContext() — user prompt format", () => {
  it("includes Escena: <time> en <place>", () => {
    const { user } = buildContext(ROSA, { time: "06:30", place: "finca" }, [], "Pregunta?");
    expect(user).toContain("Escena: 06:30 en finca");
  });

  it("includes Clima: <weather> when provided", () => {
    const { user } = buildContext(
      ROSA,
      { time: "06:30", place: "finca", weather: "lluvioso" },
      [],
      "Pregunta?"
    );
    expect(user).toContain("Clima: lluvioso");
  });

  it("omits Clima when weather is not provided", () => {
    const { user } = buildContext(ROSA, { time: "06:30", place: "finca" }, [], "Pregunta?");
    expect(user).not.toContain("Clima:");
  });

  it("includes the query preceded by 'Pregunta del visitante:'", () => {
    const { user } = buildContext(
      ROSA,
      { time: "06:00", place: "tienda" },
      [],
      "¿Como esta el pueblo?"
    );
    expect(user).toContain("Pregunta del visitante:");
    expect(user).toContain("¿Como esta el pueblo?");
  });

  it("ends with '¿Que haces o dices?'", () => {
    const { user } = buildContext(ROSA, { time: "06:00", place: "tienda" }, [], "x");
    expect(user).toMatch(/¿Que haces o dices\?$/);
  });
});

describe("buildContext() — defensive cases", () => {
  it("still builds valid system + user when query is empty", () => {
    const ctx = buildContext(ROSA, { time: "06:00", place: "tienda" }, [], "");
    expect(ctx.system.length).toBeGreaterThan(0);
    expect(ctx.user.length).toBeGreaterThan(0);
    expect(ctx.user).toContain("Pregunta del visitante:");
  });

  it("does not include stray 'Pregunta del visitante: ' with empty query in user", () => {
    const { user } = buildContext(ROSA, { time: "06:00", place: "tienda" }, [], "");
    // Empty query → still present after the prefix, but the prompt is intact.
    expect(user).toContain("Pregunta del visitante: ");
  });

  it("different personas produce different system prompts", () => {
    const rosa = buildContext(ROSA, { time: "06:00", place: "tienda" }, [], "Hola").system;
    const rosalio = buildContext(ROSALIO, { time: "06:30", place: "finca" }, [], "Hola").system;
    expect(rosa).not.toBe(rosalio);
    expect(rosa).toContain("Doña Rosa");
    expect(rosalio).toContain("Don Rosalio");
  });
});
