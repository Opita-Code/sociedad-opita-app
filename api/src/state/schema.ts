/**
 * Single-table DynamoDB schema for Sociedad Opita state.
 *
 * Key design:
 *   pk = ENTITY#<TYPE>#<id>    (e.g., ENTITY#PERSONA#don_rosalio_ganadero)
 *   sk = <subkey>[#<suffix>]   (e.g., STATE, MSG#2025-06-21T12:00:00Z)
 *
 * GSI1 byPersona (hashKey=personaId, rangeKey=sk) — events per persona
 * GSI2 byTime    (hashKey=tsBucket, rangeKey=ts)  — ventana events
 * TTL on CONV items (90 days)
 */

export const TABLE_NAME_ENV = "DDB_TABLE";
export const DEFAULT_TABLE = "SociedadOpitaState";
export const CONV_TTL_DAYS = 90;
export const ENTITY_PREFIX = "ENTITY#";

export type EntityType = "PERSONA" | "CONV" | "EVENT";

export function pk(type: EntityType, id: string): string {
  return `${ENTITY_PREFIX}${type}#${id}`;
}

export function sk(subkey: string, suffix?: string): string {
  if (suffix === undefined || suffix === "") return subkey;
  return `${subkey}#${suffix}`;
}

export function tsBucket(iso: string): string {
  return iso.substring(0, 7);
}

export function convTtlEpoch(now: number = Date.now()): number {
  return Math.floor(now / 1000) + CONV_TTL_DAYS * 24 * 60 * 60;
}

export const KEYS = {
  personaState: (personaId: string) => ({
    pk: pk("PERSONA", personaId),
    sk: sk("STATE"),
  }),
  conversationMessage: (convId: string, iso: string) => ({
    pk: pk("CONV", convId),
    sk: sk("MSG", iso),
  }),
  ventanaEvent: (iso: string, personaId: string) => ({
    pk: pk("EVENT", iso),
    sk: personaId,
  }),
} as const;

export interface PersonaState {
  personaId: string;
  emotionalState: "neutral" | "happy" | "sad" | "angry" | "anxious";
  recentEvents: string[];
  lastSeen: string;
  networkPosition: { betweenness: number; degree: number };
}

export interface ConversationTurn {
  convId: string;
  ts: string;
  role: "user" | "persona";
  personaId?: string;
  content: string;
  metadata?: Record<string, unknown>;
}

export interface VentanaEvent {
  ts: string;
  personaId: string;
  type: "tienda" | "iglesia" | "plaza" | "finca" | "otro";
  description: string;
}
