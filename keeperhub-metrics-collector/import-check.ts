/**
 * Import-graph smoke check for the metrics-collector image (TECH-6484).
 *
 * Run inside the built metrics-collector container by the collector-build-check
 * CI job. It dynamically imports the collector's two entry modules; if a future
 * change adds a runtime (value) import of a builder-generated module that the
 * trimmed image does not copy, this fails here at PR time instead of on the
 * post-merge staging deploy. (server.test.ts mocks the metrics module, so it
 * does not exercise this real import path.)
 */
async function main(): Promise<void> {
  const [api, dbMetrics] = await Promise.all([
    import("../lib/metrics/prometheus-api"),
    import("../lib/metrics/db-metrics"),
  ]);

  console.log(
    `IMPORTS_OK prometheus-api=${Object.keys(api).length} db-metrics=${Object.keys(dbMetrics).length}`
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error("IMPORT_FAIL:", message);
  process.exit(1);
});

// Marks this file as a module so `main` is module-scoped (avoids a global-scope
// name collision with other script-style entrypoints under tsc's project view).
export {};
