import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Integration tests: real Postgres (DATABASE_URL_TEST), Whop stubbed. Run with `pnpm test:integration`.
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    include: ["tests/integration/**/*.test.ts"],
    setupFiles: ["tests/integration/setup.ts"],
    fileParallelism: false,
    testTimeout: 20_000,
  },
});
