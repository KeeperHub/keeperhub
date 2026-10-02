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
 * allowance read, and all but sky/stusds-leverage-loop.json approve unlimited.
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

type HintShape = "unlimited" | "exact amount" | "no claim";

// Seeds that approve with no check-allowance node upstream, with the wording
// the hint gives each, so a failure says which seed moved and how its amount
// now reads. All but sky/stusds-leverage-loop.json approve "max", the one
// spelling the Approve Token node sends as unlimited; that one carries a
// decimal MaxUint256 the action cannot send as written.
const SEEDS_THAT_APPROVE_BLIND: Record<string, HintShape> = {
  "aave-v3/mcp-test-supply-weth.json": "unlimited",
  "aerodrome/mcp-test-swap-weth-usdc.json": "unlimited",
  "compound/mcp-test-supply-weth.json": "unlimited",
  "morpho/mcp-test-vault-deposit.json": "unlimited",
  "sky/mcp-test-convert-dai-usds.json": "unlimited",
  "sky/mcp-test-convert-usds-dai.json": "unlimited",
  "sky/stusds-leverage-loop.json": "no claim",
  "spark/mcp-test-deposit-sdai.json": "unlimited",
  "uniswap/mcp-test-swap-dai-usdc.json": "unlimited",
  "uniswap/mcp-test-swap-usdc-usde.json": "unlimited",
  "uniswap/mcp-test-swap.json": "unlimited",
  "yearn/mcp-test-deposit-yvweth.json": "unlimited",
};

// Which of the three amount claims a hint carries.
function hintShape(message: string): HintShape {
  if (message.includes("unlimited")) {
    return "unlimited";
  }
  return message.includes("exact amount") ? "exact amount" : "no claim";
}

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
  // the list and each hint's amount claim: a seed gaining or losing an
  // approve, a configured amount changing, or the detector changing shape,
  // changes it and has to be looked at.
  it("raises the approve-without-allowance-check hint on exactly the seeds that approve blind", () => {
    const shapes: Record<string, HintShape> = {};
    for (const file of files) {
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
      const hints = result.warnings.filter(
        (w) => w.code === "approve-without-allowance-check"
      );
      if (hints.length === 0) {
        continue;
      }
      const name = relative(SEED_WORKFLOW_DIR, file).split(sep).join("/");
      // One in-scope approve per seed today, so one claim per name.
      expect(hints).toHaveLength(1);
      shapes[name] = hintShape(hints[0].message);
    }
    expect(shapes).toEqual(SEEDS_THAT_APPROVE_BLIND);
  });
});
