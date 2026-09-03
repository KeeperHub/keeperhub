/**
 * Coverage test: every credentials.X read inside a plugin step file must
 * map to an envVar that appears in PLUGIN_CREDENTIAL_MAP for that plugin.
 *
 * Catches the regression class introduced in commits e2948659 / a90d3cce /
 * ca226048 (KEEP-1559/1560), where the runtime plugin registry stopped being
 * reachable from Workflow DevKit step bundles and the credential fallback
 * silently mismapped configKey vs envVar for plugins where the two differ
 * (telegram, slack, sendgrid).
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { PLUGIN_CREDENTIAL_MAP } = await import("@/lib/credential-map");

const PLUGINS_DIR = join(process.cwd(), "plugins");
const ALLOWLIST_FILE = join(PLUGINS_DIR, "plugin-allowlist.json");
const CREDENTIALS_READ_RE = /credentials\.([A-Za-z_][A-Za-z0-9_]*)/g;

const ALLOWLIST: ReadonlySet<string> = new Set(
  (JSON.parse(readFileSync(ALLOWLIST_FILE, "utf-8")) as { plugins: string[] })
    .plugins
);

type StepCredentialReads = {
  plugin: string;
  file: string;
  keys: string[];
};

function listStepFiles(plugin: string): string[] {
  const stepsDir = join(PLUGINS_DIR, plugin, "steps");
  try {
    if (!statSync(stepsDir).isDirectory()) {
      return [];
    }
  } catch {
    return [];
  }
  return readdirSync(stepsDir)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .map((f) => join(stepsDir, f));
}

function listPluginDirs(): string[] {
  return readdirSync(PLUGINS_DIR).filter((entry) => {
    if (!ALLOWLIST.has(entry)) {
      return false;
    }
    try {
      return statSync(join(PLUGINS_DIR, entry)).isDirectory();
    } catch {
      return false;
    }
  });
}

function collectCredentialReads(): StepCredentialReads[] {
  const result: StepCredentialReads[] = [];
  for (const plugin of listPluginDirs()) {
    for (const file of listStepFiles(plugin)) {
      const source = readFileSync(file, "utf-8");
      const keys = new Set<string>();
      for (const match of source.matchAll(CREDENTIALS_READ_RE)) {
        keys.add(match[1]);
      }
      if (keys.size > 0) {
        result.push({ plugin, file, keys: [...keys] });
      }
    }
  }
  return result;
}

describe("credential-map coverage vs step files", () => {
  const reads = collectCredentialReads();

  it("found at least one step file accessing credentials", () => {
    expect(
      reads.length,
      "scan returned no step files - did the directory layout move?"
    ).toBeGreaterThan(0);
  });

  it.each(
    reads
  )("$plugin/$file: every credentials.* read is declared in PLUGIN_CREDENTIAL_MAP", ({
    plugin,
    file,
    keys,
  }) => {
    const fieldMap = PLUGIN_CREDENTIAL_MAP[plugin];
    const declaredEnvVars = new Set(Object.values(fieldMap ?? {}));

    const undeclared = keys.filter((key) => !declaredEnvVars.has(key));
    expect(
      undeclared,
      `${file} reads ${undeclared.join(", ")} but PLUGIN_CREDENTIAL_MAP[${plugin}] only declares ${
        [...declaredEnvVars].join(", ") || "(none)"
      }. ` +
        "Either add the formField with the matching envVar in the plugin's index.ts " +
        "and run 'pnpm discover-plugins', or update the step to read an existing key."
    ).toEqual([]);
  });
});
