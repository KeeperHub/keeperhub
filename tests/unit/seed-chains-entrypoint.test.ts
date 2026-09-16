import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("chain seed production entrypoint", () => {
  it("executes through a symlinked path instead of silently exiting", () => {
    const root = process.cwd();
    const temporary = mkdtempSync(
      path.join(tmpdir(), "keeperhub-seed-entrypoint-")
    );
    try {
      const linkedRoot = path.join(temporary, "linked-keeperhub");
      symlinkSync(root, linkedRoot, "dir");
      const result = spawnSync(
        process.execPath,
        [
          "--import",
          "tsx",
          path.join(linkedRoot, "scripts/seed/seed-chains.ts"),
        ],
        {
          cwd: root,
          encoding: "utf8",
          timeout: 30_000,
          env: {
            ...process.env,
            DATABASE_URL: "postgres://127.0.0.1:1/keeperhub_seed_entrypoint",
            CHAIN_RPC_CONFIG: "",
          },
        }
      );

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("Connecting to database...");
      expect(result.stdout).toContain("Seeding 25 chains...");
      expect(result.stderr).toContain("Error seeding chains:");
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  }, 35_000);
});
