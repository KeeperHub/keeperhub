/**
 * Bootstrap script for workflow-runner
 *
 * This script patches the 'server-only' module before loading
 * the main workflow-runner script. This allows the runner to work outside
 * of Next.js (in K8s Jobs or local testing).
 *
 * Usage: tsx keeperhub-executor/workflow-runner-bootstrap.ts
 */

import { spawn } from "node:child_process";
import { copyFileSync, existsSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(scriptDir, "..");

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
const runner = join(scriptDir, "workflow-runner.ts");

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
  // Use 'close' instead of 'exit' to ensure stdio is flushed
  process.exit(signal ? 1 : (code ?? 0));
});

child.on("error", (err: Error) => {
  console.error("Failed to start workflow runner:", err);
  restoreServerOnly();
  process.exit(1);
});
