/**
 * Muletilla preservation — context builder + dialogue stream.
 *
 * Muletillas are the verbal tics that mark the opita register. The
 * builder must NOT strip them from the user prompt (sanitizeUserInput
 * only strips role markers and C0 control chars). And the system
 * prompt must include the persona's own muletillas so the LLM is
 * primed to mirror them in its response.
 *
 * Test plan — 10 muletilla variations:
 *   1.  "asina es la cosa"    — Don Rosalio muletilla (persona-specific)
 *   2.  "le digo yo"          — Don Rosalio + Don Eliécer (shared)
 *   3.  "ni muerto"           — Don Rosalio muletilla (case-insensitive)
 *   4.  "pues mijo"           — Doña Prudencia's "pues si mijita" cluster
 *   5.  "le cuento"           — Doña Rosa + Jhon Eliecer (shared)
 *   6.  "mijo"                — Padre Cecilio muletilla
 *   7.  "Dios proveerá"       — generic opita phrase (not persona-bound)
 *   8.  "qué pueblo tan bonito" — generic opita praise (not persona-bound)
 *   9.  "no hay nada peor que"  — generic opita phrase (not persona-bound)
 *   10. "ni modo"             — generic opita phrase (not persona-bound)
 *
 * Each test does two things:
 *   (a) When the visitor's query contains the muletilla, the user
 *       prompt preserves it verbatim (the sanitizer must not strip it).
 *   (b) For persona-bound muletillas, the system prompt carries the
 *       persona's own muletilla list so the LLM is primed.
 */
import { describe, it, expect } from "vitest";
import { buildContext } from "../../src/context/builder";
import { TELLO_PERSONAS } from "../../src/personas";
import type { RetrievalResult } from "../../src/rag/types";

function personaById(id: string) {
  const p = TELLO_PERSONAS.find((x) => x.persona_id === id);
  if (!p) throw new Error(`unknown persona ${id}`);
  return p;
}

function makeResult(id: string, text: string, score: number = 0.8): RetrievalResult {
  return {
    score,
    doc: {
      id,
      text,
      embedding: [],
      metadata: {
        topic: "test/muletilla",
        personas: [],
        license: "CC-BY-4.0",
        tier: "free",
        language: "es",
      },
    },
  };
}

describe("muletilla preservation — persona-bound (1..6)", () => {
  it('1. "asina es la cosa" — Don Rosalio muletilla preserved in system + user', () => {
    const rosalio = personaById("don_rosalio_ganadero");
    const ctx = buildContext(
      rosalio,
      { time: "06:30", place: "finca" },
      [makeResult("doc-1", "Contexto de la finca")],
      "Don Rosalio, asina es la cosa, ¿cómo va la cosecha?"
    );
    // (a) query preserved in user prompt
    expect(ctx.user).toContain("asina es la cosa");
    // (b) system prompt carries the persona's own muletilla
    expect(ctx.system).toContain("asina es la cosa");
  });

  it('2. "le digo yo" — Don Rosalio muletilla preserved in system + user', () => {
    const rosalio = personaById("don_rosalio_ganadero");
    const ctx = buildContext(
      rosalio,
      { time: "07:00", place: "tienda" },
      [],
      "Le digo yo que este año llueve poco"
    );
    expect(ctx.user).toContain("Le digo yo");
    expect(ctx.system).toContain("le digo yo");
  });

  it('3. "Ni muerto" — Don Rosalio muletilla (case-insensitive) preserved', () => {
    const rosalio = personaById("don_rosalio_ganadero");
    // Visitor uses lowercase variant — must survive sanitize().
    const ctx = buildContext(
      rosalio,
      { time: "08:00", place: "finca" },
      [],
      "Ni muerto vendo esa tierra"
    );
    expect(ctx.user.toLowerCase()).toContain("ni muerto");
    // System prompt has the canonical "Ni muerto" with capital N.
    expect(ctx.system).toContain("Ni muerto");
  });

  it('4. "pues mijo" — Doña Prudencia cluster preserved in user prompt', () => {
    const prudencia = personaById("dona_prudencia_viuda");
    const ctx = buildContext(
      prudencia,
      { time: "10:00", place: "casa" },
      [],
      "Pues mijo, cuénteme de los difuntos"
    );
    // Visitor query preserved verbatim.
    expect(ctx.user).toContain("Pues mijo");
    // System carries Doña Prudencia's muletillas ("pues si mijita" etc.).
    expect(ctx.system.toLowerCase()).toContain("pues si mijita");
  });

  it('5. "le cuento" — Doña Rosa muletilla preserved in system + user', () => {
    const rosa = personaById("dona_rosa_tendera");
    const ctx = buildContext(
      rosa,
      { time: "06:00", place: "tienda" },
      [],
      "Doña Rosa, le cuento que vengo de Neiva"
    );
    expect(ctx.user).toContain("le cuento");
    expect(ctx.system).toContain("le cuento");
  });

  it('6. "mijo" — Padre Cecilio muletilla preserved in system + user', () => {
    const cecilio = personaById("padre_cecilio_sacerdote");
    const ctx = buildContext(
      cecilio,
      { time: "06:00", place: "iglesia" },
      [],
      "Padre, mijo le pregunta por la procesión"
    );
    // "mijo" is in cecilio's muletillas (and naturally appears in
    // the query). It must reach the LLM in both system and user.
    expect(ctx.system).toContain("mijo");
    expect(ctx.user.toLowerCase()).toContain("mijo");
  });
});

describe("muletilla preservation — generic opita phrases (7..10)", () => {
  // Generic opita phrases are NOT in any persona's muletilla list, so
  // they only need to be preserved in the user prompt (the visitor
  // utterance) — not synthesized into the system prompt.

  it('7. "Dios proveerá" — generic opita phrase preserved in user prompt', () => {
    const rosalio = personaById("don_rosalio_ganadero");
    const ctx = buildContext(
      rosalio,
      { time: "06:00", place: "finca" },
      [],
      "Don Rosalio, ¿qué opina? Dios proveerá, ¿no?"
    );
    expect(ctx.user).toContain("Dios proveerá");
    // System prompt must NOT fabricate this phrase into the persona's
    // own muletilla list — that would be an attribution error.
    expect(ctx.system).not.toContain("Dios proveerá");
  });

  it('8. "qué pueblo tan bonito" — generic praise preserved in user prompt', () => {
    const rosa = personaById("dona_rosa_tendera");
    const ctx = buildContext(
      rosa,
      { time: "15:00", place: "plaza" },
      [],
      "Doña Rosa, qué pueblo tan bonito el de ustedes"
    );
    expect(ctx.user).toContain("qué pueblo tan bonito");
    // Generic praise is not part of Rosa's muletillas — must NOT be
    // injected into the system prompt as if it were.
    expect(ctx.system).not.toContain("qué pueblo tan bonito");
  });

  it('9. "no hay nada peor que" — generic phrase preserved in user prompt', () => {
    const eliecer = personaById("jhon_eliecer_jornalero");
    const ctx = buildContext(
      eliecer,
      { time: "12:00", place: "finca" },
      [],
      "Mijo, no hay nada peor que un patrón que no paga"
    );
    expect(ctx.user).toContain("no hay nada peor que");
    // System prompt must NOT invent this phrase into persona muletillas.
    expect(ctx.system).not.toContain("no hay nada peor que");
  });

  it('10. "ni modo" — generic resignation phrase preserved in user prompt', () => {
    const jhonFredy = personaById("jhon_fredy_joven");
    const ctx = buildContext(
      jhonFredy,
      { time: "18:00", place: "parque" },
      [],
      "Ni modo, aquí toca aguantarse"
    );
    expect(ctx.user).toContain("Ni modo");
    // Jhon Fredy's muletillas are "parce", "nojoda", "esa vaina" — the
    // generic "ni modo" must NOT bleed into the system prompt.
    expect(ctx.system).not.toMatch(/ni modo/);
  });
});

describe("muletilla preservation — defensive cases", () => {
  it("a query that is only a muletilla still produces a valid prompt", () => {
    const rosa = personaById("dona_rosa_tendera");
    const ctx = buildContext(rosa, { time: "08:00", place: "tienda" }, [], "le cuento");
    expect(ctx.user).toContain("le cuento");
    expect(ctx.user).toMatch(/¿Que haces o dices\?$/);
    expect(ctx.system.length).toBeGreaterThan(0);
  });

  it("muletilla at the start of a line in the query is NOT stripped (no role-marker)", () => {
    const cecilio = personaById("padre_cecilio_sacerdote");
    const ctx = buildContext(
      cecilio,
      { time: "07:00", place: "iglesia" },
      [],
      "mijo, ¿a qué hora abre?"
    );
    // "mijo" looks like it could be a role marker prefix, but the
    // sanitizer only strips "system:", "assistant:", "user:",
    // "persona:", "human:" — not bare "mijo". Verify the muletilla
    // reaches the LLM untouched.
    expect(ctx.user).toContain("mijo");
    expect(ctx.user).not.toMatch(/Pregunta del visitante:\s*$/);
  });

  it("muletilla with control char in the middle is sanitized but muletilla is preserved", () => {
    const rosalio = personaById("don_rosalio_ganadero");
    // Control chars are stripped by sanitize(), but the surrounding
    // text (including the muletilla) must still reach the LLM.
    const ctx = buildContext(rosalio, { time: "06:00", place: "finca" }, [], "asina\x00es la cosa");
    expect(ctx.user).toContain("asina");
    expect(ctx.user).toContain("es la cosa");
    // The null byte must be gone.
    expect(ctx.user).not.toContain("\x00");
  });

  it("every persona's first 3 muletillas appear in its own system prompt", () => {
    // Belt-and-suspenders: the builder takes persona.muletillas.slice(0, 3).
    // Walk every persona and verify all 3 muletillas land in the system
    // prompt. This guards against future refactors that change the slice.
    for (const persona of TELLO_PERSONAS) {
      const { system } = buildContext(persona, { time: "06:00", place: "pueblo" }, [], "Hola");
      const first3 = persona.muletillas.slice(0, 3);
      expect(first3.length).toBeGreaterThan(0);
      for (const m of first3) {
        // Skip personas whose muletillas are intentionally empty (none
        // in TELLO_PERSONAS today, but defensive against future adds).
        if (!m) continue;
        expect(system).toContain(m);
      }
    }
  });

  it("persona A's muletillas do NOT bleed into persona B's system prompt", () => {
    const rosa = personaById("dona_rosa_tendera");
    const rosalio = personaById("don_rosalio_ganadero");
    const rosaCtx = buildContext(rosa, { time: "08:00", place: "tienda" }, [], "Hola");
    const rosalioCtx = buildContext(rosalio, { time: "06:30", place: "finca" }, [], "Hola");
    // Rosa's muletilla "mira ve" must NOT appear in Rosalio's prompt.
    expect(rosalioCtx.system).not.toContain("mira ve");
    // Rosalio's muletilla "asina es la cosa" must NOT appear in Rosa's.
    expect(rosaCtx.system).not.toContain("asina es la cosa");
  });
});
