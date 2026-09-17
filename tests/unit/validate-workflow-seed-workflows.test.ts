import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { validateWorkflow } from "@/lib/mcp/validate-workflow";

/**
 * The workflows under scripts/seed/workflows are the shipped reference
 * templates: what the seeder installs and what the MCP tests exercise. They are
 * correct by construction, so an error or a spend-side allowance warning
 * against one of them is a false positive in the validator, not a defect in
 * the template. The one warning they are expected to raise is the approve-side
 * hint, pinned by name below: every seed that approves does so without an
 * allowance read, and all of them approve unlimited.
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

// Seeds that approve a token with no check-allowance node upstream, by name,
// so a failure says which seed moved. Every one of them approves unlimited
// ("max" or MaxUint256), which is what the hint's wording says on them.
const SEEDS_THAT_APPROVE_BLIND = [
  "aave-v3/mcp-test-supply-weth.json",
  "aerodrome/mcp-test-swap-weth-usdc.json",
  "compound/mcp-test-supply-weth.json",
  "morpho/mcp-test-vault-deposit.json",
  "sky/mcp-test-convert-dai-usds.json",
  "sky/mcp-test-convert-usds-dai.json",
  "sky/stusds-leverage-loop.json",
  "spark/mcp-test-deposit-sdai.json",
  "uniswap/mcp-test-swap-dai-usdc.json",
  "uniswap/mcp-test-swap-usdc-usde.json",
  "uniswap/mcp-test-swap.json",
  "yearn/mcp-test-deposit-yvweth.json",
];

describe("validateWorkflow - shipped seed workflows", () => {
  it("finds seed workflows to check", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)("%s raises no missing-allowance-preflight warning", (file) => {
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

  // The approve-side hint fires on every seed that approves without a
  // check-allowance upstream. Seeds carry no such read today, so this pins
  // the list: a seed gaining or losing an approve, or the detector changing
  // shape, changes it and has to be looked at.
  it("raises the approve-without-allowance-check hint on exactly the seeds that approve blind", () => {
    const flagged = files.filter((file) => {
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
      return result.warnings.some(
        (w) => w.code === "approve-without-allowance-check"
      );
    });
    const names = flagged.map((file) =>
      relative(SEED_WORKFLOW_DIR, file).split(sep).join("/")
    );
    expect(names).toEqual(SEEDS_THAT_APPROVE_BLIND);
  });
});
