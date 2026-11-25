import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..");

/** Source trees whose RPC access must go through lib/rpc/engine. */
const SCANNED_ROOTS = ["lib", "plugins", "app", "keeperhub-executor"];

/**
 * Paths allowed to build RPC clients or read RPC URLs themselves:
 * - lib/rpc: the engine and the managers it builds on.
 * - codegen: emits source text for exported workflows, never runs it here.
 * - the platform health probe: checks KeeperHub's own endpoints only.
 * - the legacy per-user preference routes, until that table is retired.
 */
const ALLOWED_PREFIXES = [
  "lib/rpc/",
  "lib/workflow/codegen/",
  "lib/metrics/rpc-health-probe.ts",
  "app/api/user/rpc-preferences/",
];

const SOURCE_EXTENSION = /\.(ts|tsx)$/;
const SKIPPED_SEGMENTS = new Set(["node_modules", ".next", "dist"]);

const BYPASSES: readonly { name: string; pattern: RegExp }[] = [
  {
    name: "ethers provider built outside the engine",
    pattern: /new\s+(?:ethers\.)?(?:JsonRpcProvider|WebSocketProvider)\(/,
  },
  {
    name: "Solana connection built outside the engine",
    pattern: /new\s+Connection\(/,
  },
  { name: "viem http transport on a raw URL", pattern: /transport:\s*http\(/ },
  {
    name: "chain RPC URL read outside the engine",
    pattern: /getRpcUrlByChainId/,
  },
  {
    name: "legacy RPC resolver import",
    pattern: /from\s+["']@\/lib\/rpc\/(?:config-service|provider-factory)["']/,
  },
];

function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (SKIPPED_SEGMENTS.has(entry)) {
      continue;
    }
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      files.push(...sourceFiles(path));
    } else if (SOURCE_EXTENSION.test(entry) && !entry.includes(".test.")) {
      files.push(path);
    }
  }
  return files;
}

function isAllowed(file: string): boolean {
  return ALLOWED_PREFIXES.some((prefix) => file.startsWith(prefix));
}

describe("RPC engine guard", () => {
  it("routes every RPC client through lib/rpc/engine", () => {
    const offenders: string[] = [];
    for (const root of SCANNED_ROOTS) {
      for (const path of sourceFiles(join(ROOT, root))) {
        const file = relative(ROOT, path);
        if (isAllowed(file)) {
          continue;
        }
        const text = readFileSync(path, "utf8");
        for (const bypass of BYPASSES) {
          if (bypass.pattern.test(text)) {
            offenders.push(`${file}: ${bypass.name}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
