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
        expiresAt: "number", // TTL (epoch seconds)
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
    //   Polish R7: reserved concurrency cap = 10 invocations — prevents
    //     runaway cost if abused / DoS (Lambda + DDB are pay-per-call).
    //   Polish R7: explicit log retention 1 month (default) for cost.
    //   Polish R5: DEEPSEEK_API_KEY now sourced from an encrypted
    //     `sst.Secret` (see DEPLOY-RUNBOOK.md for the `sst secret set`
    //     procedure). The secret value is interpolated into the
    //     Lambda's environment at deploy time; `process.env` reads
    //     inside the handler (api/src/llm/provider.ts) see it normally.
    const DEEPSEEK_API_KEY_SECRET = new sst.Secret("DeepSeekApiKey");
    const apiFn = new sst.aws.Function("ApiFn", {
      url: true,
      handler: "src/api.handler",
      link: [sessionsTable, personasTable, stateTable],
      environment: {
        DEEPSEEK_API_KEY: DEEPSEEK_API_KEY_SECRET.value,
        DEEPSEEK_BASE_URL: process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com/v1",
        DDB_TABLE: stateTable.name,
        CORPUS_PATH:
          process.env.CORPUS_PATH ||
          "/tmp/corpus-embeddings.bge-m3-v1.json.gz",
        STAGE: $app.stage,
      },
      memory: "2048 MB",
      timeout: "60 seconds",
      architecture: "arm64",
      concurrency: {
        reserved: 10,
      },
      logging: {
        retention: "1 month",
        format: "json",
      },
    });

    // ─── Router (api.sociedad.opitacode.com) ───────────────────
    const router = new sst.aws.Router("ApiRouter", {
      domain:
        $app.stage === "prod"
          ? "api.sociedad.opitacode.com"
          : `api-dev.sociedad.opitacode.com`,
      routes: {
        "/*": apiFn.url,
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
