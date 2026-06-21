import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { OCAISProviderError } from "@opita/ocais";

// Mock @opita/ocais BEFORE importing the module under test.
// vi.mock is hoisted, so vi.mocked() must be used at runtime to access the mock.
vi.mock("@opita/ocais", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@opita/ocais")>();
  return {
    ...actual,
    streamText: vi.fn(),
    openai: vi.fn(() => ({ name: "openai-mock", _mock: true })),
  };
});

import { streamText } from "@opita/ocais";
import { ocaisStream } from "../../src/llm/provider";

const mockStreamText = vi.mocked(streamText);

/** Helper: collect all chunks from the async generator into an array. */
async function collect(
  gen: AsyncGenerator<{ type: string; text?: string; cost?: number }>,
): Promise<Array<{ type: string; text?: string; cost?: number }>> {
  const out: Array<{ type: string; text?: string; cost?: number }> = [];
  for await (const chunk of gen) out.push(chunk);
  return out;
}

describe("ocaisStream", () => {
  beforeEach(() => {
    mockStreamText.mockReset();
    process.env.DEEPSEEK_API_KEY = "test-key";
    process.env.DEEPSEEK_BASE_URL = "https://api.deepseek.com/v1";
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("yields text chunks in order, then a done chunk with cost", async () => {
    mockStreamText.mockReturnValueOnce(
      (async function* () {
        yield { type: "text", text: "Hola" } as never;
        yield { type: "text", text: " mundo" } as never;
      })() as never,
    );

    const chunks = await collect(ocaisStream({ system: "s", user: "u" }));
    const textChunks = chunks.filter((c) => c.type === "text");
    const doneChunks = chunks.filter((c) => c.type === "done");

    expect(textChunks.map((c) => c.text).join("")).toBe("Hola mundo");
    expect(doneChunks).toHaveLength(1);
    expect(doneChunks[0]!.cost).toBeGreaterThan(0);
  });

  it("defaults model to deepseek-chat when not provided", async () => {
    mockStreamText.mockReturnValueOnce(
      (async function* () {
        yield { type: "text", text: "x" } as never;
      })() as never,
    );

    await collect(ocaisStream({ system: "s", user: "u" }));

    expect(mockStreamText).toHaveBeenCalledTimes(1);
    const call = mockStreamText.mock.calls[0]![0];
    expect(call.model).toBe("deepseek-chat");
  });

  it("uses provided model when given", async () => {
    mockStreamText.mockReturnValueOnce(
      (async function* () {
        yield { type: "text", text: "x" } as never;
      })() as never,
    );

    await collect(ocaisStream({ system: "s", user: "u", model: "deepseek-reasoner" }));

    const call = mockStreamText.mock.calls[0]![0];
    expect(call.model).toBe("deepseek-reasoner");
  });

  it("retries 3x on 5xx with exponential backoff (1s, 2s, 4s)", async () => {
    vi.useFakeTimers();
    let attempts = 0;
    mockStreamText.mockImplementation(() => {
      attempts++;
      if (attempts < 3) {
        throw new OCAISProviderError("deepseek", 503, "upstream down");
      }
      return (async function* () {
        yield { type: "text", text: "ok" } as never;
      })() as never;
    });

    const sleepSpy = vi.spyOn(globalThis, "setTimeout");

    const promise = collect(ocaisStream({ system: "s", user: "u" }));

    // Advance through the two backoff windows (1s + 2s) — the 3rd attempt succeeds.
    await vi.runAllTimersAsync();
    const chunks = await promise;

    expect(attempts).toBe(3);
    expect(chunks.find((c) => c.type === "text")?.text).toBe("ok");
    // First delay was ~1000ms, second ~2000ms (exponential base 2).
    const delays = sleepSpy.mock.calls.map((c) => c[1]);
    expect(delays[0]).toBe(1000);
    expect(delays[1]).toBe(2000);
  });

  it("throws OCAISError after exhausting 3 retries on persistent 5xx", async () => {
    vi.useFakeTimers();
    let attempts = 0;
    mockStreamText.mockImplementation(() => {
      attempts++;
      throw new OCAISProviderError("deepseek", 502, "bad gateway");
    });

    // Attach the rejection handler BEFORE running timers so vitest never sees
    // the rejection as unhandled.
    const expectation = expect(
      collect(ocaisStream({ system: "s", user: "u" })),
    ).rejects.toThrow(/Upstream 5xx after 3 retries/);

    await vi.runAllTimersAsync();
    await expectation;
    expect(attempts).toBe(3);
  });

  it("does NOT retry on 4xx (client errors are caller bugs, not transient)", async () => {
    let attempts = 0;
    mockStreamText.mockImplementation(() => {
      attempts++;
      throw new OCAISProviderError("deepseek", 400, "bad request");
    });

    await expect(
      collect(ocaisStream({ system: "s", user: "u" })),
    ).rejects.toThrow();

    expect(attempts).toBe(1);
  });

  it("passes system prompt and user message to streamText", async () => {
    mockStreamText.mockReturnValueOnce(
      (async function* () {
        yield { type: "text", text: "x" } as never;
      })() as never,
    );

    await collect(
      ocaisStream({
        system: "you are rosa",
        user: "hola",
        temperature: 0.7,
      }),
    );

    const call = mockStreamText.mock.calls[0]![0];
    expect(call.system).toBe("you are rosa");
    expect(call.messages).toEqual([{ role: "user", content: "hola" }]);
    expect(call.temperature).toBe(0.7);
  });

  it("logs cost on done chunk proportional to total streamed text length", async () => {
    mockStreamText.mockReturnValueOnce(
      (async function* () {
        // 40 chars → 10 tokens → 10/1_000_000 * 0.14 = 1.4e-6 USD
        yield { type: "text", text: "a".repeat(40) } as never;
      })() as never,
    );

    const chunks = await collect(ocaisStream({ system: "s", user: "u" }));
    const done = chunks.find((c) => c.type === "done") as { type: "done"; cost: number };
    expect(done.cost).toBeCloseTo((10 / 1_000_000) * 0.14, 10);
  });
});
