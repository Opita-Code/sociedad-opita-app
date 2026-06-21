import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { sendMock, fromMock } = vi.hoisted(() => {
  const send = vi.fn();
  const from = vi.fn(() => ({ send }));
  return { sendMock: send, fromMock: from };
});

vi.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: vi.fn(() => ({})),
}));

vi.mock("@aws-sdk/lib-dynamodb", () => ({
  DynamoDBDocumentClient: { from: fromMock },
  PutCommand: vi.fn((input: unknown) => ({ __cmd: "Put", input })),
  GetCommand: vi.fn((input: unknown) => ({ __cmd: "Get", input })),
  QueryCommand: vi.fn((input: unknown) => ({ __cmd: "Query", input })),
  UpdateCommand: vi.fn((input: unknown) => ({ __cmd: "Update", input })),
}));

import {
  putItem,
  getItem,
  queryByPersona,
  queryByTime,
  getTableName,
  updateItem,
} from "../../src/state/dynamo-client";

interface PutCommandInput {
  TableName: string;
  Item: Record<string, unknown>;
}

interface GetCommandInput {
  TableName: string;
  Key: Record<string, unknown>;
}

interface QueryCommandInput {
  TableName: string;
  IndexName?: string;
  KeyConditionExpression?: string;
  ExpressionAttributeNames?: Record<string, string>;
  ExpressionAttributeValues?: Record<string, unknown>;
  Limit?: number;
  ScanIndexForward?: boolean;
}

interface UpdateCommandInput {
  TableName: string;
  Key: Record<string, unknown>;
  UpdateExpression: string;
  ExpressionAttributeNames?: Record<string, string>;
  ExpressionAttributeValues?: Record<string, unknown>;
}

function lastPut(): PutCommandInput {
  const cmd = sendMock.mock.calls[sendMock.mock.calls.length - 1]![0] as {
    __cmd: string;
    input: PutCommandInput;
  };
  expect(cmd.__cmd).toBe("Put");
  return cmd.input;
}

function lastGet(): GetCommandInput {
  const cmd = sendMock.mock.calls[sendMock.mock.calls.length - 1]![0] as {
    __cmd: string;
    input: GetCommandInput;
  };
  expect(cmd.__cmd).toBe("Get");
  return cmd.input;
}

function lastQuery(): QueryCommandInput {
  const cmd = sendMock.mock.calls[sendMock.mock.calls.length - 1]![0] as {
    __cmd: string;
    input: QueryCommandInput;
  };
  expect(cmd.__cmd).toBe("Query");
  return cmd.input;
}

function lastUpdate(): UpdateCommandInput {
  const cmd = sendMock.mock.calls[sendMock.mock.calls.length - 1]![0] as {
    __cmd: string;
    input: UpdateCommandInput;
  };
  expect(cmd.__cmd).toBe("Update");
  return cmd.input;
}

describe("dynamo-client.getTableName", () => {
  beforeEach(() => {
    delete process.env.DDB_TABLE;
  });
  afterEach(() => {
    delete process.env.DDB_TABLE;
  });

  it("returns DDB_TABLE env when set", () => {
    process.env.DDB_TABLE = "CustomTable";
    expect(getTableName()).toBe("CustomTable");
  });

  it("returns DEFAULT_TABLE 'SociedadOpitaState' when env unset", () => {
    delete process.env.DDB_TABLE;
    expect(getTableName()).toBe("SociedadOpitaState");
  });
});

describe("dynamo-client.putItem", () => {
  beforeEach(() => {
    sendMock.mockReset();
    process.env.DDB_TABLE = "TestTable";
  });
  afterEach(() => {
    delete process.env.DDB_TABLE;
  });

  it("calls docClient.send with PutCommand + marshalled item", async () => {
    sendMock.mockResolvedValueOnce({});
    await putItem({ pk: "X", sk: "Y", name: "z" });
    const input = lastPut();
    expect(input.TableName).toBe("TestTable");
    expect(input.Item).toEqual({ pk: "X", sk: "Y", name: "z" });
  });

  it("sets expiresAt when ttl option is provided", async () => {
    sendMock.mockResolvedValueOnce({});
    await putItem({ pk: "X", sk: "Y" }, { ttl: 1_700_000_000 });
    const input = lastPut();
    expect(input.Item.expiresAt).toBe(1_700_000_000);
  });

  it("does NOT set expiresAt when ttl option is undefined", async () => {
    sendMock.mockResolvedValueOnce({});
    await putItem({ pk: "X", sk: "Y" });
    const input = lastPut();
    expect(input.Item.expiresAt).toBeUndefined();
    expect("expiresAt" in input.Item).toBe(false);
  });

  it("preserves all original item attributes", async () => {
    sendMock.mockResolvedValueOnce({});
    const item = {
      pk: "ENTITY#PERSONA#x",
      sk: "STATE",
      personaId: "x",
      emotionalState: "happy",
      lastSeen: "2025-06-21T12:00:00Z",
    };
    await putItem(item);
    const input = lastPut();
    expect(input.Item).toEqual(item);
  });
});

describe("dynamo-client.getItem", () => {
  beforeEach(() => {
    sendMock.mockReset();
    process.env.DDB_TABLE = "TestTable";
  });
  afterEach(() => {
    delete process.env.DDB_TABLE;
  });

  it("calls docClient.send with GetCommand + key", async () => {
    sendMock.mockResolvedValueOnce({ Item: { pk: "X", sk: "Y", val: 1 } });
    await getItem("X", "Y");
    const input = lastGet();
    expect(input.TableName).toBe("TestTable");
    expect(input.Key).toEqual({ pk: "X", sk: "Y" });
  });

  it("returns the unmarshalled Item", async () => {
    sendMock.mockResolvedValueOnce({
      Item: { pk: "X", sk: "Y", name: "rosa" },
    });
    const result = await getItem<{ pk: string; sk: string; name: string }>("X", "Y");
    expect(result).toEqual({ pk: "X", sk: "Y", name: "rosa" });
  });

  it("returns null when no Item in response", async () => {
    sendMock.mockResolvedValueOnce({});
    const result = await getItem("X", "Y");
    expect(result).toBeNull();
  });
});

describe("dynamo-client.queryByPersona (GSI1 byPersona)", () => {
  beforeEach(() => {
    sendMock.mockReset();
    process.env.DDB_TABLE = "TestTable";
  });
  afterEach(() => {
    delete process.env.DDB_TABLE;
  });

  it("queries GSI byPersona with personaId as hashKey", async () => {
    sendMock.mockResolvedValueOnce({
      Items: [{ personaId: "don_rosalio", sk: "STATE" }],
    });
    const result = await queryByPersona("don_rosalio");
    const input = lastQuery();
    expect(input.TableName).toBe("TestTable");
    expect(input.IndexName).toBe("byPersona");
    expect(input.ExpressionAttributeValues).toEqual({ ":pid": "don_rosalio" });
    expect(input.KeyConditionExpression).toContain("personaId");
    expect(input.KeyConditionExpression).toContain(":pid");
    expect(result).toEqual([{ personaId: "don_rosalio", sk: "STATE" }]);
  });

  it("supports skPrefix option (begins_with sk)", async () => {
    sendMock.mockResolvedValueOnce({ Items: [] });
    await queryByPersona("don_rosalio", { skPrefix: "STATE" });
    const input = lastQuery();
    expect(input.ExpressionAttributeValues).toMatchObject({
      ":pid": "don_rosalio",
      ":skp": "STATE",
    });
    expect(input.KeyConditionExpression).toContain("begins_with");
  });

  it("supports limit option", async () => {
    sendMock.mockResolvedValueOnce({ Items: [] });
    await queryByPersona("don_rosalio", { limit: 5 });
    const input = lastQuery();
    expect(input.Limit).toBe(5);
  });

  it("returns empty array when no Items", async () => {
    sendMock.mockResolvedValueOnce({});
    const result = await queryByPersona("nobody");
    expect(result).toEqual([]);
  });
});

describe("dynamo-client.queryByTime (GSI2 byTime)", () => {
  beforeEach(() => {
    sendMock.mockReset();
    process.env.DDB_TABLE = "TestTable";
  });
  afterEach(() => {
    delete process.env.DDB_TABLE;
  });

  it("queries GSI byTime with tsBucket as hashKey, ts as rangeKey", async () => {
    sendMock.mockResolvedValueOnce({
      Items: [{ tsBucket: "2025-06", ts: "2025-06-21T12:00:00Z" }],
    });
    const result = await queryByTime("2025-06");
    const input = lastQuery();
    expect(input.TableName).toBe("TestTable");
    expect(input.IndexName).toBe("byTime");
    expect(input.ExpressionAttributeValues).toEqual({ ":bucket": "2025-06" });
    expect(input.KeyConditionExpression).toContain("tsBucket");
    expect(input.KeyConditionExpression).toContain("ts");
    expect(input.ScanIndexForward).toBe(false);
    expect(result).toHaveLength(1);
  });

  it("supports tsGte option (ts >= value)", async () => {
    sendMock.mockResolvedValueOnce({ Items: [] });
    await queryByTime("2025-06", { tsGte: "2025-06-01T00:00:00Z" });
    const input = lastQuery();
    expect(input.KeyConditionExpression).toContain(">=");
    expect(input.ExpressionAttributeValues).toMatchObject({
      ":tsGte": "2025-06-01T00:00:00Z",
    });
  });

  it("supports tsLte option (ts <= value)", async () => {
    sendMock.mockResolvedValueOnce({ Items: [] });
    await queryByTime("2025-06", { tsLte: "2025-06-30T23:59:59Z" });
    const input = lastQuery();
    expect(input.KeyConditionExpression).toContain("<=");
    expect(input.ExpressionAttributeValues).toMatchObject({
      ":tsLte": "2025-06-30T23:59:59Z",
    });
  });

  it("returns events sorted descending by default (ScanIndexForward=false)", async () => {
    sendMock.mockResolvedValueOnce({ Items: [] });
    await queryByTime("2025-06");
    const input = lastQuery();
    expect(input.ScanIndexForward).toBe(false);
  });
});

describe("dynamo-client.queryByPartition (primary index)", () => {
  beforeEach(() => {
    sendMock.mockReset();
    process.env.DDB_TABLE = "TestTable";
  });
  afterEach(() => {
    delete process.env.DDB_TABLE;
  });

  it("queries primary index by pk", async () => {
    sendMock.mockResolvedValueOnce({
      Items: [{ pk: "ENTITY#CONV#c1", sk: "MSG#t1" }],
    });
    const { queryByPartition } = await import("../../src/state/dynamo-client");
    const result = await queryByPartition("ENTITY#CONV#c1");
    const input = lastQuery();
    expect(input.IndexName).toBeUndefined();
    expect(input.KeyConditionExpression).toBe("pk = :pk");
    expect(input.ExpressionAttributeValues).toEqual({
      ":pk": "ENTITY#CONV#c1",
    });
    expect(result).toHaveLength(1);
  });

  it("supports begins_with(sk, prefix) when skPrefix given", async () => {
    sendMock.mockResolvedValueOnce({ Items: [] });
    const { queryByPartition } = await import("../../src/state/dynamo-client");
    await queryByPartition("ENTITY#CONV#c1", { skPrefix: "MSG#" });
    const input = lastQuery();
    expect(input.KeyConditionExpression).toContain("begins_with");
    expect(input.ExpressionAttributeValues).toMatchObject({
      ":skp": "MSG#",
    });
  });

  it("supports scanForward option", async () => {
    sendMock.mockResolvedValueOnce({ Items: [] });
    const { queryByPartition } = await import("../../src/state/dynamo-client");
    await queryByPartition("ENTITY#CONV#c1", { scanForward: true });
    const input = lastQuery();
    expect(input.ScanIndexForward).toBe(true);
  });
});

describe("dynamo-client.updateItem", () => {
  beforeEach(() => {
    sendMock.mockReset();
    process.env.DDB_TABLE = "TestTable";
  });
  afterEach(() => {
    delete process.env.DDB_TABLE;
  });

  it("calls docClient.send with UpdateCommand + key + updates", async () => {
    sendMock.mockResolvedValueOnce({});
    await updateItem("ENTITY#PERSONA#don_rosalio", "STATE", {
      emotionalState: "happy",
      lastSeen: "2025-06-21T12:00:00Z",
    });
    const input = lastUpdate();
    expect(input.TableName).toBe("TestTable");
    expect(input.Key).toEqual({ pk: "ENTITY#PERSONA#don_rosalio", sk: "STATE" });
    expect(input.ExpressionAttributeValues).toEqual({
      ":emotionalState": "happy",
      ":lastSeen": "2025-06-21T12:00:00Z",
    });
  });

  it("builds UpdateExpression with all update fields separated by commas", async () => {
    sendMock.mockResolvedValueOnce({});
    await updateItem("pk", "sk", { a: 1, b: 2, c: 3 });
    const input = lastUpdate();
    expect(input.UpdateExpression).toContain("a = :a");
    expect(input.UpdateExpression).toContain("b = :b");
    expect(input.UpdateExpression).toContain("c = :c");
  });

  it("uses ExpressionAttributeNames for reserved words (e.g., 'name', 'type')", async () => {
    sendMock.mockResolvedValueOnce({});
    await updateItem("pk", "sk", { name: "rosa", type: "persona" });
    const input = lastUpdate();
    expect(input.ExpressionAttributeNames).toBeDefined();
    expect(input.ExpressionAttributeNames!["#name"]).toBe("name");
    expect(input.ExpressionAttributeNames!["#type"]).toBe("type");
    expect(input.UpdateExpression).toContain("#name = :name");
    expect(input.UpdateExpression).toContain("#type = :type");
  });
});

describe("dynamo-client module-level setup", () => {
  it("creates DynamoDBDocumentClient via .from() at module load", () => {
    expect(fromMock).toHaveBeenCalled();
  });

  it("uses marshallOptions.removeUndefinedValues=true", () => {
    expect(fromMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        marshallOptions: expect.objectContaining({
          removeUndefinedValues: true,
        }),
      })
    );
  });
});
