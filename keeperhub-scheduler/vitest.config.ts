import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts"],
    exclude: ["node_modules", "dist"],
    testTimeout: 10_000,
    // Producers now require a signing secret (SQS message HMAC); provide a test
    // value so enqueue paths exercise real signing instead of throwing.
    env: { INTERNAL_SERVICE_HMAC_SECRET: "test-hmac-secret" },
  },
});
