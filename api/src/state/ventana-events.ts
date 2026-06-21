/**
 * Ventana events — append-only event log with 2 GSIs.
 *
 * Schema:
 *   pk       = ENTITY#EVENT#<iso>
 *   sk       = <personaId>
 *   personaId = <personaId>     (GSI1 byPersona hashKey)
 *   tsBucket = "yyyy-mm"        (GSI2 byTime hashKey)
 *   ts       = <iso>            (GSI2 byTime rangeKey)
 *
 * GSI1 byPersona: hashKey=personaId, rangeKey=sk — events per persona
 * GSI2 byTime:    hashKey=tsBucket, rangeKey=ts — events per month window
 *
 * Events are durable (no TTL) — ventana timeline is a historical log.
 */

import { putItem, queryByPersona, queryByTime } from "./dynamo-client";
import { KEYS, tsBucket, type VentanaEvent } from "./schema";

export interface AppendEventInput {
  ts: string;
  personaId: string;
  type: VentanaEvent["type"];
  description: string;
}

export async function appendEvent(event: AppendEventInput): Promise<void> {
  const { pk, sk } = KEYS.ventanaEvent(event.ts, event.personaId);
  const bucket = tsBucket(event.ts);

  await putItem({
    pk,
    sk,
    personaId: event.personaId,
    tsBucket: bucket,
    ts: event.ts,
    type: event.type,
    description: event.description,
  });
}

export interface EventsRangeOptions {
  since?: string;
  until?: string;
  limit?: number;
}

export async function getEventsByPersona(
  personaId: string,
  options?: EventsRangeOptions
): Promise<VentanaEvent[]> {
  const items = await queryByPersona<Record<string, unknown>>(personaId, {
    limit: options?.limit,
  });
  const filtered = filterByTsRange(items, options);
  return sortByTsDesc(filtered);
}

export async function getEventsByTimeBucket(
  bucket: string,
  options?: EventsRangeOptions
): Promise<VentanaEvent[]> {
  const items = await queryByTime<Record<string, unknown>>(bucket, {
    tsGte: options?.since,
    tsLte: options?.until,
    limit: options?.limit,
  });
  return sortByTsDesc(items);
}

function filterByTsRange(
  items: Record<string, unknown>[],
  options?: EventsRangeOptions
): Record<string, unknown>[] {
  if (!options?.since && !options?.until) return items;
  return items.filter((item) => {
    const ts = String(item.ts ?? "");
    if (options.since && ts < options.since) return false;
    if (options.until && ts > options.until) return false;
    return true;
  });
}

function sortByTsDesc(items: Record<string, unknown>[]): VentanaEvent[] {
  const mapped = items.map(
    (raw): VentanaEvent => ({
      ts: String(raw.ts ?? ""),
      personaId: String(raw.personaId ?? ""),
      type: (raw.type as VentanaEvent["type"]) ?? "otro",
      description: String(raw.description ?? ""),
    })
  );
  mapped.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
  return mapped;
}
