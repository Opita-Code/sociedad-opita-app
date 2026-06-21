/**
 * Conversation store — append + retrieve with TTL 90 days.
 *
 * Schema:
 *   pk = ENTITY#CONV#<convId>
 *   sk = MSG#<iso>
 *   expiresAt = now + 90 days (epoch seconds)
 *
 * Reads use Query on the primary index with begins_with(sk, "MSG#")
 * so all turns under a conversation are returned in sk-ascending order
 * (timestamps sort lexicographically when ISO-8601).
 */

import { putItem, queryByPartition } from "./dynamo-client";
import { convTtlEpoch, KEYS, type ConversationTurn } from "./schema";

export interface AppendTurnInput {
  convId: string;
  ts: string;
  role: "user" | "persona";
  content: string;
  personaId?: string;
  metadata?: Record<string, unknown>;
}

export async function appendTurn(turn: AppendTurnInput): Promise<void> {
  const { pk, sk } = KEYS.conversationMessage(turn.convId, turn.ts);
  const ttl = convTtlEpoch();

  await putItem(
    {
      pk,
      sk,
      convId: turn.convId,
      ts: turn.ts,
      role: turn.role,
      personaId: turn.personaId,
      content: turn.content,
      metadata: turn.metadata,
    },
    { ttl }
  );
}

export async function getConversation(convId: string): Promise<ConversationTurn[]> {
  const { pk: partitionKey } = KEYS.conversationMessage(convId, "");

  const items = await queryByPartition<Record<string, unknown>>(partitionKey, {
    skPrefix: "MSG#",
    scanForward: true,
  });

  return items.map((raw): ConversationTurn => {
    return {
      convId: String(raw.convId ?? convId),
      ts: String(raw.ts ?? ""),
      role: (raw.role as "user" | "persona") ?? "user",
      personaId: raw.personaId as string | undefined,
      content: String(raw.content ?? ""),
      metadata: raw.metadata as Record<string, unknown> | undefined,
    };
  });
}
