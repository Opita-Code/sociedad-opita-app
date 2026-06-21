/**
 * LLM provider config — the single source of truth for the active LLM.
 *
 * Why this exists
 * ───────────────
 * v2 shipped with DeepSeek and embedded the LLM identity in 8 files:
 *   - sst.config.ts        (secret name + env var name)
 *   - src/llm/provider.ts (baseURL, env-var read, default model)
 *   - src/llm/cost-tracker.ts (pricing per 1M output tokens)
 *   - src/api.ts           (legacy /v1/simulate — same fields again)
 *   - src/handlers/dialogue.ts (model name in cost recording)
 *   - 3 test files         (env var resets + literal model assertions)
 *
 * To swap LLM providers we had to touch all 8. That's an antipattern —
 * the LLM is data, not code. This module is the single place that
 * knows about the active provider, and every consumer reads from it.
 *
 * How to switch LLMs
 * ──────────────────
 * 1. Add or update an entry in `LLM_PROVIDERS` below.
 * 2. Set the env var `LLM_PROVIDER` at deploy time (or change
 *    `DEFAULT_PROVIDER`).
 * 3. sst deploy.
 * 4. Tests pick up the new provider automatically — no test edits
 *    needed unless the test is asserting provider-specific behavior.
 *
 * The SST secret name is `LlmApiKey` (one secret, regardless of which
 * provider is active). The corresponding env var is `LLM_API_KEY`.
 *
 * Adding a new model to an existing provider
 * ──────────────────────────────────────────
 * Add a `LlmModelConfig` entry under that provider's `models` map.
 * Lookup in `getOutputCostPer1MUsd()` is automatic.
 *
 * Adding a new provider
 * ─────────────────────
 * 1. Add a new `LlmProviderConfig` entry to `LLM_PROVIDERS`.
 * 2. If the API isn't OpenAI-compatible, also extend the OCAIS
 *    provider factory switch in `provider.ts`.
 * 3. Set the operator-supplied key via the `LlmApiKey` SST secret
 *    (it gets the value; the `apiKeyEnvVar` field below declares
 *    which env var on the Lambda receives the value).
 */

export interface LlmModelConfig {
  /** Model name as it appears in API requests (e.g., "MiniMax-M3"). */
  name: string;
  /** USD per 1M output tokens. */
  outputCostPer1MUsd: number;
  /** USD per 1M input tokens (informational; tokens_in not yet tracked). */
  inputCostPer1MUsd: number;
  /** USD per 1M cached input tokens (informational). */
  cachedInputCostPer1MUsd: number;
  /** Default temperature for this model. */
  defaultTemperature: number;
}

export interface LlmProviderConfig {
  /** Human-readable ID (e.g., "MiniMax", "deepseek"). */
  id: string;
  /** OCAIS provider factory to call (e.g., "openai", "google"). */
  ocaProvider: "openai" | "google";
  /** API base URL (no trailing slash). */
  baseURL: string;
  /** Env var name on the Lambda that holds the API key. */
  apiKeyEnvVar: string;
  /** The default model name for this provider (also the active model
   *  when the provider is selected and no override is given). */
  defaultModel: string;
  /** All models this provider supports, keyed by model name. */
  models: Record<string, LlmModelConfig>;
}

/**
 * Catalog of supported providers. Add a new entry here to onboard a
 * new LLM without touching any consumer file.
 */
export const LLM_PROVIDERS: Record<string, LlmProviderConfig> = {
  MiniMax: {
    id: "MiniMax",
    ocaProvider: "openai", // MiniMax API is OpenAI-compatible
    baseURL: "https://api.MiniMax.io/v1",
    apiKeyEnvVar: "LLM_API_KEY",
    defaultModel: "MiniMax-M3",
    models: {
      "MiniMax-M3": {
        name: "MiniMax-M3",
        outputCostPer1MUsd: 1.5,
        inputCostPer1MUsd: 0.3,
        cachedInputCostPer1MUsd: 0.03,
        defaultTemperature: 1.3,
      },
    },
  },
  deepseek: {
    id: "deepseek",
    ocaProvider: "openai", // DeepSeek is OpenAI-compatible
    baseURL: "https://api.deepseek.com/v1",
    apiKeyEnvVar: "LLM_API_KEY",
    defaultModel: "deepseek-chat",
    models: {
      "deepseek-chat": {
        name: "deepseek-chat",
        outputCostPer1MUsd: 0.14,
        inputCostPer1MUsd: 0.14,
        cachedInputCostPer1MUsd: 0.014,
        defaultTemperature: 1.3,
      },
      "deepseek-reasoner": {
        name: "deepseek-reasoner",
        outputCostPer1MUsd: 2.19,
        inputCostPer1MUsd: 2.19,
        cachedInputCostPer1MUsd: 0.219,
        defaultTemperature: 1.0,
      },
    },
  },
};

/** The default provider when LLM_PROVIDER is unset. */
export const DEFAULT_PROVIDER = "MiniMax";

/**
 * The active provider ID. Resolved once at module init from the
 * `LLM_PROVIDER` env var (which sst.config.ts sets at deploy time).
 */
export const ACTIVE_PROVIDER_ID: string = process.env.LLM_PROVIDER ?? DEFAULT_PROVIDER;

/**
 * The resolved config for the active provider. Throws if the
 * configured provider is not in the catalog (fail fast at startup).
 */
const _activeProvider: LlmProviderConfig = (() => {
  const cfg = LLM_PROVIDERS[ACTIVE_PROVIDER_ID];
  if (!cfg) {
    const known = Object.keys(LLM_PROVIDERS).join(", ");
    throw new Error(`Unknown LLM provider '${ACTIVE_PROVIDER_ID}'. Known: ${known}.`);
  }
  return cfg;
})();
export const LLM_CONFIG: LlmProviderConfig = _activeProvider;

/**
 * The active model. Always exists in `LLM_CONFIG.models` because
 * `defaultModel` is a key into the models map.
 */
const _activeModel: LlmModelConfig = (() => {
  const m = _activeProvider.models[_activeProvider.defaultModel];
  if (!m) {
    throw new Error(
      `Active provider '${_activeProvider.id}' has no model for defaultModel='${_activeProvider.defaultModel}'.`
    );
  }
  return m;
})();
export const LLM_MODEL: LlmModelConfig = _activeModel;

/** Resolve the API key from the active provider's env var. */
export function getLlmApiKey(): string {
  return process.env[LLM_CONFIG.apiKeyEnvVar] ?? "";
}

/** Get the model config by name, regardless of which provider it belongs to. */
export function getModelConfig(modelName: string): LlmModelConfig | undefined {
  for (const provider of Object.values(LLM_PROVIDERS)) {
    const m = provider.models[modelName];
    if (m) return m;
  }
  return undefined;
}

/** Get the output cost rate (USD per 1M tokens) for a given model name.
 *  Falls back to the active provider's default rate if the model is
 *  unknown — conservative direction (slight overcharge, never under). */
export function getOutputCostPer1MUsd(modelName: string): number {
  const m = getModelConfig(modelName);
  if (m) return m.outputCostPer1MUsd;
  return LLM_MODEL.outputCostPer1MUsd;
}

/** Get the default temperature for a given model name. */
export function getDefaultTemperature(modelName: string): number {
  const m = getModelConfig(modelName);
  if (m) return m.defaultTemperature;
  return LLM_MODEL.defaultTemperature;
}
