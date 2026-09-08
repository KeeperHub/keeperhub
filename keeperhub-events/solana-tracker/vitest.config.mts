import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts"],
    exclude: ["node_modules"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
    // Producers now require a signing secret (SQS message HMAC); provide a test
    // value so enqueue paths exercise real signing instead of throwing.
    env: { INTERNAL_SERVICE_HMAC_SECRET: "test-hmac-secret" },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./"),
    },
  },
});
