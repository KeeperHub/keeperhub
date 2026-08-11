/**
 * Bootstrap script for workflow-runner-profiled
 *
 * This script patches the 'server-only' module before loading
 * the profiled workflow-runner script. This allows the runner to work outside
 * of Next.js (in local testing/profiling).
 *
 * Usage: tsx scripts/runtime/workflow_runtime_analysis/workflow-runner-profiled-bootstrap.ts
 *
 * Required env vars (set in .env or pass directly):
 *   WORKFLOW_ID - ID of the workflow to execute
 *   EXECUTION_ID - ID of the execution record
 *   DATABASE_URL - PostgreSQL connection string
 */

import { spawn } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const scriptDir = import.meta.dirname;
const projectRoot = join(scriptDir, "..", "..", "..");

// Load .env file if it exists
const envPath = join(projectRoot, ".env");
if (existsSync(envPath)) {
  const envContent = readFileSync(envPath, "utf8");
  for (const line of envContent.split("\n")) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith("#")) {
      const eqIndex = trimmed.indexOf("=");
      if (eqIndex > 0) {
        const key = trimmed.slice(0, eqIndex);
        let value = trimmed.slice(eqIndex + 1);
        // Remove surrounding quotes if present
        if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          value = value.slice(1, -1);
        }
        // Only set if not already in environment (allow overrides)
        if (!process.env[key]) {
          process.env[key] = value;
        }
      }
    }
  }
}

// Create a shim for server-only in node_modules to avoid the error
const serverOnlyPaths = [
  join(projectRoot, "node_modules", "server-only", "index.js"),
  join(
    projectRoot,
    "node_modules",
    ".pnpm",
    "server-only@0.0.1",
    "node_modules",
    "server-only",
    "index.js"
  ),
];

// Backup and replace server-only
const backups: Array<{ path: string; backup: string }> = [];
for (const serverOnlyPath of serverOnlyPaths) {
  if (existsSync(serverOnlyPath)) {
    const backup = `${serverOnlyPath}.backup`;
    if (!existsSync(backup)) {
      copyFileSync(serverOnlyPath, backup);
    }
    writeFileSync(serverOnlyPath, "module.exports = {};");
    backups.push({ path: serverOnlyPath, backup });
  }
}

// Run the actual script using tsx
const tsx = join(projectRoot, "node_modules", ".bin", "tsx");
const runner = join(scriptDir, "workflow-runner-profiled.ts");

function restoreServerOnly(): void {
  for (const { path: p, backup } of backups) {
    if (existsSync(backup)) {
      try {
        copyFileSync(backup, p);
        unlinkSync(backup);
      } catch {
        // Ignore cleanup errors
      }
    }
  }
}

const child = spawn(tsx, [runner], {
  stdio: ["ignore", "pipe", "pipe"],
  env: process.env,
  cwd: projectRoot,
});

// Forward child output to parent without keeping event loop alive
child.stdout.on("data", (data: Buffer) => process.stdout.write(data));
child.stderr.on("data", (data: Buffer) => process.stderr.write(data));

// Forward signals to child
process.on("SIGTERM", () => {
  child.kill("SIGTERM");
});

process.on("SIGINT", () => {
  child.kill("SIGINT");
});

child.on("close", (code: number | null, signal: string | null) => {
  restoreServerOnly();
  process.exit(signal ? 1 : (code ?? 0));
});

child.on("error", (err: Error) => {
  console.error("Failed to start profiled workflow runner:", err);
  restoreServerOnly();
  process.exit(1);
});
