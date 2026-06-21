/**
 * Persona state — get/set with defaults + recent-events FIFO (max 5).
 *
 * Stored at KEYS.personaState(personaId):
 *   pk = ENTITY#PERSONA#<personaId>
 *   sk = STATE
 *
 * Default state:
 *   emotionalState = "neutral"
 *   recentEvents   = []
 *   lastSeen       = "1970-01-01T00:00:00Z" (epoch 0)
 *   networkPosition = { betweenness: 0, degree: 0 }
 *
 * TTL: persona state is durable — no expiresAt set.
 */

import { getItem, putItem } from "./dynamo-client";
import { KEYS, type PersonaState } from "./schema";

const RECENT_EVENTS_MAX = 5;

export function defaultPersonaState(personaId: string): PersonaState {
  return {
    personaId,
    emotionalState: "neutral",
    recentEvents: [],
    lastSeen: "1970-01-01T00:00:00Z",
    networkPosition: { betweenness: 0, degree: 0 },
  };
}

export async function getPersonaState(personaId: string): Promise<PersonaState> {
  const { pk, sk } = KEYS.personaState(personaId);
  const stored = await getItem<Partial<PersonaState>>(pk, sk);
  if (!stored) return defaultPersonaState(personaId);

  const defaults = defaultPersonaState(personaId);
  return {
    personaId: stored.personaId ?? defaults.personaId,
    emotionalState: stored.emotionalState ?? defaults.emotionalState,
    recentEvents: Array.isArray(stored.recentEvents) ? stored.recentEvents : defaults.recentEvents,
    lastSeen: stored.lastSeen ?? defaults.lastSeen,
    networkPosition: stored.networkPosition ?? defaults.networkPosition,
  };
}

export async function setPersonaState(
  personaId: string,
  partial: Partial<PersonaState>
): Promise<void> {
  const { pk, sk } = KEYS.personaState(personaId);
  const current = await getPersonaState(personaId);

  const merged: PersonaState = {
    ...current,
    ...partial,
    personaId,
  };

  // Enforce recentEvents FIFO (max 5) if caller supplied them
  if (Array.isArray(partial.recentEvents)) {
    const evs = partial.recentEvents;
    merged.recentEvents =
      evs.length > RECENT_EVENTS_MAX ? evs.slice(evs.length - RECENT_EVENTS_MAX) : evs;
  } else if (!merged.recentEvents) {
    merged.recentEvents = [];
  }

  await putItem({
    pk,
    sk,
    ...merged,
  });
}
