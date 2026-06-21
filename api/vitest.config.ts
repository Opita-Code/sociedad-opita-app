import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
  // The corpus is embedded as a binary via esbuild's `binary` loader
  // (sst.config.ts). For local test runs, vitest uses Vite which doesn't
  // know about .gz by default — `assetsInclude` tells Vite to treat the
  // file as a static asset and return a URL (we don't actually read it
  // in tests because loadCorpus is mocked in handlers/dialogue tests).
  assetsInclude: ["**/*.gz"],
});
