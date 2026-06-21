/**
 * Polish R5 smoke check — exercises the production honoApp end-to-end.
 * Not part of vitest; run with `pnpm tsx scripts/smoke-r5.ts`.
 */
import { honoApp } from "../src/api";

function header(label: string): void {
  console.log("\n=== " + label + " ===");
}

async function show(label: string, res: Response): Promise<void> {
  console.log(label);
  console.log("  Status: " + res.status);
  console.log("  ACA-Origin: " + res.headers.get("Access-Control-Allow-Origin"));
  console.log("  ACA-Methods: " + res.headers.get("Access-Control-Allow-Methods"));
  console.log("  ACA-Headers: " + res.headers.get("Access-Control-Allow-Headers"));
  console.log(
    "  ACA-Credentials: " + res.headers.get("Access-Control-Allow-Credentials"),
  );
  console.log("  ACA-Max-Age: " + res.headers.get("Access-Control-Max-Age"));
  console.log("  Body: " + (await res.text()).slice(0, 200));
}

async function main(): Promise<void> {
  header("Preflight OPTIONS /v1/dialogue");
  await show(
    "OPTIONS",
    await honoApp.request("/v1/dialogue", { method: "OPTIONS" }),
  );

  header("GET /health");
  await show("GET", await honoApp.request("/health"));

  header("POST /v1/dialogue (invalid_json)");
  await show(
    "POST",
    await honoApp.request("/v1/dialogue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    }),
  );

  header("POST /v1/dialogue (validation_failed — empty body)");
  await show(
    "POST",
    await honoApp.request("/v1/dialogue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    }),
  );

  header("POST /v1/dialogue (validation_failed — opita unicode preserved)");
  await show(
    "POST",
    await honoApp.request("/v1/dialogue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        persona_id: "dona_rosa_tendera",
        scene: { time: "06:00", place: "tienda" },
        query: "Niño Jesús, ¿cómo amaneció?",
      }),
    }),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
