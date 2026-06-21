/**
 * DynamoDB single-table client wrapper.
 *
 * Single-table key schema:
 *   pk = ENTITY#<TYPE>#<id>     (e.g., ENTITY#PERSONA#don_rosalio)
 *   sk = <subkey>               (e.g., STATE, MSG#2025-06-21T12:00:00Z)
 *
 * GSI1 byPersona (hashKey=personaId, rangeKey=sk)
 * GSI2 byTime    (hashKey=tsBucket, rangeKey=ts)
 *
 * TTL on CONV items: `expiresAt` epoch seconds (90 days from now).
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { TABLE_NAME_ENV, DEFAULT_TABLE } from "./schema";

const baseClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(baseClient, {
  marshallOptions: {
    removeUndefinedValues: true,
    convertEmptyValues: false,
  },
});

export function getTableName(): string {
  return process.env[TABLE_NAME_ENV] || DEFAULT_TABLE;
}

export async function putItem<T extends Record<string, unknown>>(
  item: T,
  options?: { ttl?: number }
): Promise<void> {
  const tableName = getTableName();
  const itemWithTtl = options?.ttl !== undefined ? { ...item, expiresAt: options.ttl } : item;
  await docClient.send(
    new PutCommand({
      TableName: tableName,
      Item: itemWithTtl,
    })
  );
}

export async function getItem<T = Record<string, unknown>>(
  pk: string,
  sk: string
): Promise<T | null> {
  const tableName = getTableName();
  const result = await docClient.send(
    new GetCommand({
      TableName: tableName,
      Key: { pk, sk },
    })
  );
  return (result.Item as T | undefined) ?? null;
}

export async function queryByPersona<T = Record<string, unknown>>(
  personaId: string,
  options?: { skPrefix?: string; limit?: number }
): Promise<T[]> {
  const tableName = getTableName();

  let keyExpr = "personaId = :pid";
  const exprValues: Record<string, unknown> = { ":pid": personaId };

  if (options?.skPrefix !== undefined) {
    keyExpr += " AND begins_with(sk, :skp)";
    exprValues[":skp"] = options.skPrefix;
  }

  const result = await docClient.send(
    new QueryCommand({
      TableName: tableName,
      IndexName: "byPersona",
      KeyConditionExpression: keyExpr,
      ExpressionAttributeValues: exprValues,
      Limit: options?.limit,
    })
  );

  return (result.Items as T[] | undefined) ?? [];
}

export async function queryByPartition<T = Record<string, unknown>>(
  partitionKey: string,
  options?: { skPrefix?: string; limit?: number; scanForward?: boolean }
): Promise<T[]> {
  const tableName = getTableName();

  const exprValues: Record<string, unknown> = { ":pk": partitionKey };
  let keyExpr = "pk = :pk";

  if (options?.skPrefix !== undefined) {
    keyExpr += " AND begins_with(sk, :skp)";
    exprValues[":skp"] = options.skPrefix;
  }

  const result = await docClient.send(
    new QueryCommand({
      TableName: tableName,
      KeyConditionExpression: keyExpr,
      ExpressionAttributeValues: exprValues,
      Limit: options?.limit,
      ScanIndexForward: options?.scanForward,
    })
  );

  return (result.Items as T[] | undefined) ?? [];
}

export async function queryByTime<T = Record<string, unknown>>(
  tsBucket: string,
  options?: { tsGte?: string; tsLte?: string; limit?: number }
): Promise<T[]> {
  const tableName = getTableName();

  let keyExpr = "tsBucket = :bucket";
  const exprValues: Record<string, unknown> = { ":bucket": tsBucket };

  if (options?.tsGte !== undefined) {
    keyExpr += " AND ts >= :tsGte";
    exprValues[":tsGte"] = options.tsGte;
  }
  if (options?.tsLte !== undefined) {
    keyExpr += " AND ts <= :tsLte";
    exprValues[":tsLte"] = options.tsLte;
  }

  const result = await docClient.send(
    new QueryCommand({
      TableName: tableName,
      IndexName: "byTime",
      KeyConditionExpression: keyExpr,
      ExpressionAttributeValues: exprValues,
      Limit: options?.limit,
      ScanIndexForward: false,
    })
  );

  return (result.Items as T[] | undefined) ?? [];
}

const RESERVED_KEYWORDS = new Set([
  "name",
  "type",
  "status",
  "data",
  "value",
  "values",
  "key",
  "timestamp",
  "time",
  "date",
  "year",
  "month",
  "day",
]);

export async function updateItem(
  pk: string,
  sk: string,
  updates: Record<string, unknown>
): Promise<void> {
  const tableName = getTableName();

  const exprNames: Record<string, string> = {};
  const exprValues: Record<string, unknown> = {};
  const setClauses: string[] = [];

  for (const [k, v] of Object.entries(updates)) {
    const placeholder = `:${k}`;
    if (RESERVED_KEYWORDS.has(k.toLowerCase())) {
      const nameAlias = `#${k}`;
      exprNames[nameAlias] = k;
      setClauses.push(`${nameAlias} = ${placeholder}`);
    } else {
      setClauses.push(`${k} = ${placeholder}`);
    }
    exprValues[placeholder] = v;
  }

  await docClient.send(
    new UpdateCommand({
      TableName: tableName,
      Key: { pk, sk },
      UpdateExpression: `SET ${setClauses.join(", ")}`,
      ExpressionAttributeNames: Object.keys(exprNames).length > 0 ? exprNames : undefined,
      ExpressionAttributeValues: exprValues,
    })
  );
}
