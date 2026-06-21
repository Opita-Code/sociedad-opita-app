/**
 * Input validation + sanitization for POST /v1/dialogue.
 *
 * Polish R5 (security hardening):
 *  - Centralized validation so the handler stays slim and we can test
 *    every edge case (opita unicode, control chars, length limits) in
 *    isolation from the Hono request/response cycle.
 *  - sanitizeUserInput() guards the prompt-injection surface: it strips
 *    role markers ("system:", "assistant:", "user:", "persona:", "human:")
 *    at the start of a line and removes control characters that the
 *    DeepSeek chat API has no reason to see in a visitor question.
 *  - The persona whitelist prevents injection of arbitrary persona_ids
 *    that could be used to probe the prompt template for RAG leaks.
 */
import { TELLO_PERSONAS } from "../personas";

export const MAX_QUERY_LENGTH = 1000;
export const MAX_PLACE_LENGTH = 200;
export const MAX_WEATHER_LENGTH = 100;
export const MAX_CONV_ID_LENGTH = 64;

export const TIME_REGEX = /^([01]\d|2[0-3]):[0-5]\d$/;
export const CONV_ID_REGEX = /^[a-zA-Z0-9_-]{1,64}$/;

// C0 control chars (0x00-0x08, 0x0B, 0x0C, 0x0E-0x1F) + DEL (0x7F).
// We keep \n (0x0A), \t (0x09), \r (0x0D) is intentionally stripped so
// logs and prompts don't carry Windows line endings into the LLM context.
export const CONTROL_CHARS_REGEX = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

export interface ValidationError {
  field: string;
  message: string;
}

export interface ValidDialogueRequest {
  persona_id: string;
  scene: { time: string; place: string; weather?: string };
  query: string;
  conv_id?: string;
}

export type ValidationResult =
  | { ok: true; data: ValidDialogueRequest }
  | { ok: false; errors: ValidationError[] };

const PERSONA_WHITELIST: ReadonlySet<string> = new Set(
  TELLO_PERSONAS.map((p) => p.persona_id),
);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Remove C0 control characters and DEL from a string. Keeps newlines (\n)
 * and tabs (\t) intact. Preserves all unicode.
 */
export function stripControlChars(s: string): string {
  return s.replace(CONTROL_CHARS_REGEX, "");
}

// Role markers that the LLM prompt format uses. Strips them at the start
// of any line (multi-line aware). Prevents a malicious visitor from
// opening a fake "system:" channel in their query.
const ROLE_MARKER_REGEX = /^[ \t]*(system|assistant|user|persona|human):[ \t]*/gim;

/**
 * Sanitize the user-supplied query before it is embedded and inserted
 * into the LLM prompt. Defensive against the most common prompt-injection
 * shapes (role-marker injection, control-char smuggling). Preserves
 * opita unicode and natural Spanish punctuation.
 */
export function sanitizeUserInput(query: string): string {
  let s = stripControlChars(query);
  s = s.replace(ROLE_MARKER_REGEX, "");
  // Collapse runs of 3+ newlines to 2 (defensive — keep paragraphs natural).
  s = s.replace(/\n{3,}/g, "\n\n");
  s = s.trim();
  return s;
}

function pushError(errors: ValidationError[], field: string, message: string): void {
  errors.push({ field, message });
}

export function validateDialogueRequest(body: unknown): ValidationResult {
  const errors: ValidationError[] = [];

  if (!isPlainObject(body)) {
    pushError(errors, "body", "Request body must be a JSON object");
    return { ok: false, errors };
  }

  // ── persona_id ──────────────────────────────────────────────
  const personaIdRaw = body.persona_id;
  if (typeof personaIdRaw !== "string" || personaIdRaw.length === 0) {
    pushError(errors, "persona_id", "persona_id must be a non-empty string");
  } else if (!PERSONA_WHITELIST.has(personaIdRaw)) {
    pushError(
      errors,
      "persona_id",
      `persona_id must be in the TELLO_PERSONAS whitelist (got '${personaIdRaw}')`,
    );
  }

  // ── scene ───────────────────────────────────────────────────
  const sceneRaw = body.scene;
  if (!isPlainObject(sceneRaw)) {
    pushError(errors, "scene", "scene must be an object");
  } else {
    const time = sceneRaw.time;
    if (typeof time !== "string" || !TIME_REGEX.test(time)) {
      pushError(
        errors,
        "scene.time",
        "scene.time must match HH:MM 24h format (e.g., '06:30')",
      );
    }
    const place = sceneRaw.place;
    if (typeof place !== "string" || place.length === 0) {
      pushError(errors, "scene.place", "scene.place must be a non-empty string");
    } else if (place.length > MAX_PLACE_LENGTH) {
      pushError(
        errors,
        "scene.place",
        `scene.place must be at most ${MAX_PLACE_LENGTH} characters`,
      );
    }
    if (sceneRaw.weather !== undefined) {
      if (typeof sceneRaw.weather !== "string") {
        pushError(
          errors,
          "scene.weather",
          "scene.weather must be a string when provided",
        );
      } else if (sceneRaw.weather.length > MAX_WEATHER_LENGTH) {
        pushError(
          errors,
          "scene.weather",
          `scene.weather must be at most ${MAX_WEATHER_LENGTH} characters`,
        );
      }
    }
  }

  // ── query ───────────────────────────────────────────────────
  const queryRaw = body.query;
  let cleanedQuery: string | undefined;
  if (typeof queryRaw !== "string") {
    pushError(errors, "query", "query must be a string");
  } else {
    cleanedQuery = stripControlChars(queryRaw);
    if (cleanedQuery.length === 0) {
      pushError(errors, "query", "query must contain at least one printable character");
    } else if (cleanedQuery.length > MAX_QUERY_LENGTH) {
      pushError(
        errors,
        "query",
        `query must be at most ${MAX_QUERY_LENGTH} characters (after stripping control chars)`,
      );
    }
  }

  // ── conv_id (optional) ─────────────────────────────────────
  let cleanedConvId: string | undefined;
  if (body.conv_id !== undefined) {
    if (typeof body.conv_id !== "string") {
      pushError(errors, "conv_id", "conv_id must be a string when provided");
    } else if (!CONV_ID_REGEX.test(body.conv_id)) {
      pushError(
        errors,
        "conv_id",
        "conv_id must be 1-64 chars of [A-Za-z0-9_-] (no spaces or punctuation)",
      );
    } else {
      cleanedConvId = body.conv_id;
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  // All checks passed — type-narrow the references for the data object.
  const scene = sceneRaw as { time: string; place: string; weather?: string };
  const data: ValidDialogueRequest = {
    persona_id: personaIdRaw as string,
    scene: {
      time: scene.time,
      place: scene.place,
      weather: scene.weather,
    },
    query: cleanedQuery as string,
    conv_id: cleanedConvId,
  };
  return { ok: true, data };
}
