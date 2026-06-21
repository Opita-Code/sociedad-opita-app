/**
 * ocaisStream — typed wrapper around OCAIS streamText.
 *
 * Implements:
 *   - REQ-3.1: yield text chunks in order
 *   - REQ-3.2: yield a final { type: "done", cost } chunk with USD estimate
 *   - REQ-3.3: retry 3x on 5xx with exponential backoff (1s, 2s, 4s);
 *              do NOT retry on 4xx (those are caller bugs).
 *
 * Error policy:
 *   - 4xx OCAISProviderError → throw immediately (caller bug, retrying won't help).
 *   - 5xx OCAISProviderError → retry up to 3 attempts.
 *   - Any other error → retry up to 3 attempts (treated as transient).
 *   - After 3 failed attempts → throw a wrapped OCAISError with message
 *     "Upstream 5xx after 3 retries" so the HTTP handler can return 502.
 *
 * Phase 1: in-process retry loop with await + setTimeout. Each retry re-enters
 * the upstream API. Acceptable for Lambda where total invocation is bounded.
 */
import { streamText, openai, OCAISProviderError, OCAISError } from "@opita/ocais";
import { estimateCost } from "./cost-tracker";

export interface OcaisStreamOptions {
  system: string;
  user: string;
  model?: string;
  temperature?: number;
}

export type OcaisChunk = { type: "text"; text: string } | { type: "done"; cost: number };

const DEFAULT_MODEL = "deepseek-chat";
const DEFAULT_TEMPERATURE = 1.3;
const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 1000;

function isRetryable(err: unknown): boolean {
  // 4xx is never retryable — it's a caller-side bug.
  if (err instanceof OCAISProviderError && err.status >= 400 && err.status < 500) {
    return false;
  }
  // Everything else (5xx, network errors, OCAIS abort, unknown) is retryable.
  return true;
}

function backoffMs(attempt: number): number {
  // attempt=1 → 1000ms, attempt=2 → 2000ms, attempt=3 → 4000ms
  return BASE_BACKOFF_MS * 2 ** (attempt - 1);
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function* ocaisStream(opts: OcaisStreamOptions): AsyncGenerator<OcaisChunk> {
  const model = opts.model ?? DEFAULT_MODEL;
  const temperature = opts.temperature ?? DEFAULT_TEMPERATURE;

  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const stream = streamText({
        provider: openai({
          apiKey: process.env.DEEPSEEK_API_KEY ?? "",
          baseURL: process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com/v1",
        }),
        model,
        system: opts.system,
        messages: [{ role: "user", content: opts.user }],
        temperature,
      });

      let full = "";
      for await (const chunk of stream) {
        if (chunk.type === "text") {
          full += chunk.text;
          yield { type: "text", text: chunk.text };
        }
      }
      yield { type: "done", cost: estimateCost(full, model) };
      return;
    } catch (err) {
      lastError = err;
      if (!isRetryable(err)) throw err;
      if (attempt < MAX_ATTEMPTS) {
        await sleep(backoffMs(attempt));
      }
    }
  }

  // Exhausted retries. Wrap the last error so HTTP handlers can return 502.
  const cause = lastError instanceof Error ? lastError : new Error(String(lastError));
  throw new OCAISError(`Upstream 5xx after ${MAX_ATTEMPTS} retries: ${cause.message}`, cause);
}
