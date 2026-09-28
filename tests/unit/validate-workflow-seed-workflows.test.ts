import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { validateWorkflow } from "@/lib/mcp/validate-workflow";

/**
 * The workflows under scripts/seed/workflows are the shipped reference
 * templates: what the seeder installs and what the MCP tests exercise. They are
 * correct by construction, so any warning the validator raises against one of
 * them is a false positive in the validator, not a defect in the template.
 *
 * This pins that contract. It is the cheapest guard against a widened check
 * regressing on real node shapes: seed nodes are created by the seeder rather
 * than the editor, so they carry the field shapes editor-built fixtures do not.
 */
const SEED_WORKFLOW_DIR = join("scripts", "seed", "workflows");

function seedWorkflowFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      out.push(...seedWorkflowFiles(path));
    } else if (entry.endsWith(".json")) {
      out.push(path);
    }
  }
  return out.sort();
}

const files = seedWorkflowFiles(SEED_WORKFLOW_DIR);

describe("validateWorkflow - shipped seed workflows", () => {
  it("finds seed workflows to check", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)("%s raises no allowance warning", (file) => {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Record<
      string,
      unknown
    >;
    const result = validateWorkflow({
      id: file,
      nodes: Array.isArray(raw.nodes) ? raw.nodes : [],
      edges: Array.isArray(raw.edges) ? raw.edges : [],
      inputSchema: null,
      outputMapping: null,
      isListed: false,
      workflowType: raw.type === "write" ? "write" : "read",
    });
    const allowanceWarnings = result.warnings.filter(
      (w) => w.code === "missing-allowance-preflight"
    );
    expect(allowanceWarnings).toEqual([]);
  });
});
