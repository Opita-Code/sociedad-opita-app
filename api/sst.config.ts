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
    const apiFn = new sst.aws.Function("ApiFn", {
      url: true,
      handler: "src/api.handler",
      link: [sessionsTable, personasTable, stateTable],
      environment: {
        DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY || "",
        DEEPSEEK_BASE_URL: process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com/v1",
        DDB_TABLE: stateTable.name,
        STAGE: $app.stage,
      },
      memory: "512 MB",
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
