/// <reference path="./.sst/platform/config.d.ts" />

/**
 * Sociedad Opita API — SST v3 config
 *
 * Patrón alineado con opita-links:
 * - Stage prod con removal retain
 * - DynamoDB tables con primary index + TTL
 * - Lambda Functions con URL (Function URL = endpoint directo)
 * - Router con custom domain
 * - Link automático de resources a las functions
 */

export default $config({
  app(input) {
    return {
      name: "sociedad-opita-app",
      removal: input?.stage === "prod" ? "retain" : "remove",
      home: "aws",
    };
  },
  async run() {
    const dotenv = await import("dotenv");
    dotenv.config();

    // ─── Sesiones Table ──────────────────────────────────────────
    const sessionsTable = new sst.aws.Dynamo("Sessions", {
      fields: {
        sessionId: "string",
      },
      primaryIndex: { hashKey: "sessionId" },
      ttl: "expiresAt",
    });

    // ─── Personas Table (snapshot inmutable de las 41 personas) ──
    const personasTable = new sst.aws.Dynamo("Personas", {
      fields: {
        ciudadId: "string",
        personaId: "string",
      },
      primaryIndex: { hashKey: "ciudadId", rangeKey: "personaId" },
    });

    // ─── State Table (single-table, PR #7) ──────────────────────
    //   pk     = ENTITY#<TYPE>#<id>          (PERSONA | CONV | EVENT)
    //   sk     = <subkey>                   (STATE, MSG#<iso>, personaId)
    //   GSI1 byPersona: hashKey=personaId, rangeKey=sk  — events per persona
    //   GSI2 byTime:    hashKey=tsBucket,   rangeKey=ts  — ventana events per month
    //   TTL on CONV items: `expiresAt` epoch seconds, 90 days.
    const stateTable = new sst.aws.Dynamo("SociedadOpitaState", {
      fields: {
        pk: "string",
        sk: "string",
        personaId: "string", // GSI1 hashKey
        tsBucket: "string",  // GSI2 hashKey
        ts: "string",        // GSI2 rangeKey
      },
      primaryIndex: { hashKey: "pk", rangeKey: "sk" },
      globalIndexes: {
        byPersona: { hashKey: "personaId", rangeKey: "sk" },
        byTime: { hashKey: "tsBucket", rangeKey: "ts" },
      },
      ttl: "expiresAt",
    });

    // ─── API Handler (Hono on Lambda) ───────────────────────────
    //   PR #9: bumped memory to 2048 MB to fit Xenova/bge-m3 (q8 ONNX,
    //   ~600MB model + activations) for server-side query embedding.
    //   PR #9: bumped timeout to 60s to absorb the 5-8s cold-start tax
    //   when the model has to load on a fresh Lambda container.
    //   PR #9: added CORPUS_PATH env var (S3-baked artifact in Phase 2).
    //   Polish R7: architecture arm64 explicit (REQ-7.1 deviation fix —
    //     Graviton2 = ~34% better price/perf vs x86_64 per AWS docs,
    //     no native x86 dependencies in our Node 22 + Hono 4 stack).
    //   Polish R7: reserved concurrency cap — REMOVED in prod deploy
    //     because the AWS account-level ConcurrentExecutions limit is
    //     only 10 (sandbox tier) and AWS requires UnreservedConcurrent
    //     Execution to stay ≥ 10. With reserved=1 unreserved would be 9.
    //     The "do not exceed N concurrent invocations" guard is
    //     replaced by:
    //       (a) the rate-limiter in api/src/llm/rate-limiter.ts (10 req/min/IP)
    //       (b) the cost cap in runbooks/cost-overrun.md
    //     For accounts with higher limits, restore:
    //         concurrency: { reserved: 10 }
    //   Polish R7: explicit log retention 1 month (default) for cost.
    //   Polish R5: LLM_API_KEY now sourced from an encrypted
    //     `sst.Secret` (see DEPLOY-RUNBOOK.md for the `sst secret set`
    //     procedure). The secret value is interpolated into the
    //     Lambda's environment at deploy time; `process.env` reads
    //     inside the handler (api/src/llm/config.ts) see it normally.
    //   2026-06-21: provider identity centralised in api/src/llm/config.ts.
    //     The env var name (LLM_API_KEY) is provider-agnostic. To switch
    //     providers, edit LLM_PROVIDERS in config.ts and set the
    //     `LLM_PROVIDER` env var (or change DEFAULT_PROVIDER) — no other
    //     consumer file needs editing.
    const LLM_API_KEY_SECRET = new sst.Secret("LlmApiKey");
    const apiFn = new sst.aws.Function("ApiFn", {
      url: true,
      handler: "src/api.handler",
      link: [sessionsTable, personasTable, stateTable],
      environment: {
        LLM_API_KEY: LLM_API_KEY_SECRET.value,
        LLM_PROVIDER: process.env.LLM_PROVIDER || "MiniMax",
        DDB_TABLE: stateTable.name,
        CORPUS_PATH:
          process.env.CORPUS_PATH ||
          "/tmp/corpus-embeddings.bge-m3-v1.json.gz",
        STAGE: $app.stage,
      },
      memory: "2048 MB",
      timeout: "60 seconds",
      architecture: "arm64",
      // concurrency: { reserved: 5 } — removed: account limit is 10.
      // See runbooks/cost-overrun.md + rate-limiter for DoS guard.
      logging: {
        retention: "1 month",
        format: "json",
      },
      nodejs: {
        // Externalise the AWS SDK v3 — already present in the Lambda
        // Node 22 base image, and pnpm's symlinked node_modules break
        // esbuild's file walker with Win32 ERROR_INVALID_FUNCTION
        // ("Incorrect function") during bundle on Windows.
        esbuild: {
          external: [
            "@aws-sdk/client-dynamodb",
            "@aws-sdk/lib-dynamodb",
            "@aws-sdk/client-s3",
            "@aws-sdk/lib-storage",
          ],
        },
        // Embed the corpus gz as a binary Uint8Array at bundle time.
        // The .gz file is ~1MB and is imported by dialogue.ts via
        //   import corpusGz from "./assets/corpus.bge-m3-v1.json.gz";
        // esbuild's `binary` loader returns the raw bytes so we can
        // pass them straight to loadCorpusFromBuffer() at module init.
        // (SST v3 takes `nodejs.loader` at the top level, not under
        // `nodejs.esbuild` — see .sst/platform/.../function.ts:998.)
        loader: {
          ".gz": "binary",
        },
      },
    });

    // ─── Router (api.sociedad.opitacode.com) ───────────────────
    // The /v1/dialogue endpoint streams an SSE response from MiniMax-M3
    // that takes 10-20s in practice. CloudFront's default route
    // readTimeout is 20s, which produces 504s on long streams. Bump
    // it to 60s (the documented max) to give the LLM room. The
    // keepAliveTimeout is bumped too so a slow chunk in the middle
    // of the stream doesn't drop the connection.
    const router = new sst.aws.Router("ApiRouter", {
      domain:
        $app.stage === "prod"
          ? "api.sociedad.opitacode.com"
          : `api-dev.sociedad.opitacode.com`,
      routes: {
        "/*": {
          url: apiFn.url,
          readTimeout: "60 seconds",
          keepAliveTimeout: "60 seconds",
        },
      },
    });

    return {
      ApiUrl: apiFn.url,
      RouterUrl: router.url,
      SessionsTable: sessionsTable.name,
      PersonasTable: personasTable.name,
      StateTable: stateTable.name,
    };
  },
});
