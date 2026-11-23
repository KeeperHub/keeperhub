import { PLUGIN_STEP_IMPORTERS } from "../../lib/step-registry";

/**
 * Import the step modules for every action type that starts with one of the
 * given prefixes. A warm pod runs this while it waits, so the first step of
 * the run it claims does not pay for loading its module and dependencies.
 *
 * Failures are counted, not thrown: a module that fails to load here fails the
 * same way when the step runs, and is reported there with the run's context.
 */
export async function preloadStepModules(
  prefixes: readonly string[]
): Promise<{ loaded: number; failed: number }> {
  let loaded = 0;
  let failed = 0;
  if (prefixes.length === 0) {
    return { loaded, failed };
  }
  for (const [actionType, entry] of Object.entries(PLUGIN_STEP_IMPORTERS)) {
    if (!prefixes.some((prefix) => actionType.startsWith(prefix))) {
      continue;
    }
    try {
      await entry.importer();
      loaded++;
    } catch {
      failed++;
    }
  }
  return { loaded, failed };
}

export function parsePreloadPrefixes(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  return value
    .split(",")
    .map((prefix) => prefix.trim())
    .filter((prefix) => prefix.length > 0);
}
