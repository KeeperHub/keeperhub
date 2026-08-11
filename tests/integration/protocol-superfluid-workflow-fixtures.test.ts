/**
 * Superfluid Workflow Fixture Validation
 *
 * The fixtures in `fixtures/superfluid-workflows/` are the canonical
 * workflow JSONs used to verify Superfluid actions end-to-end against a
 * deployed PR environment. They double as a regression set: if the
 * protocol drifts (action removed, contract key renamed, chain dropped),
 * these fixtures should fail to validate against the live registry.
 *
 * This test does NOT make network calls. It only checks that each
 * fixture's references agree with `protocols/superfluid.ts`. Runs in CI
 * unconditionally.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import superfluidDef, { SUPERFLUID_CHAIN_IDS } from "@/protocols/superfluid";

const FIXTURE_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures/superfluid-workflows"
);
const SUPPORTED_CHAINS: readonly string[] = SUPERFLUID_CHAIN_IDS;

type WorkflowConfig = {
  actionType?: string;
  network?: string;
  _protocolMeta?: string;
  [key: string]: unknown;
};

type WorkflowNode = {
  id: string;
  type: "trigger" | "action";
  data: { config: WorkflowConfig };
};

type Workflow = {
  name: string;
  nodes: WorkflowNode[];
  edges: Array<{ id: string; source: string; target: string }>;
};

type ProtocolMeta = {
  protocolSlug: string;
  contractKey: string;
  functionName: string;
  actionType: "read" | "write";
};

function loadFixtures(): Array<{ file: string; workflow: Workflow }> {
  const files = fs
    .readdirSync(FIXTURE_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort();
  return files.map((file) => {
    const raw = fs.readFileSync(path.join(FIXTURE_DIR, file), "utf-8");
    return { file, workflow: JSON.parse(raw) as Workflow };
  });
}

const fixtures = loadFixtures();
const SUPERFLUID_PREFIX = "superfluid/";

describe("Superfluid workflow fixtures", () => {
  it("fixture directory contains at least one JSON", () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });

  for (const { file, workflow } of fixtures) {
    describe(file, () => {
      it("has a name and at least one trigger plus one action node", () => {
        expect(workflow.name).toBeTruthy();
        expect(workflow.nodes.some((n) => n.type === "trigger")).toBe(true);
        expect(workflow.nodes.some((n) => n.type === "action")).toBe(true);
      });

      const superfluidActions = workflow.nodes.filter(
        (n) =>
          n.type === "action" &&
          typeof n.data.config.actionType === "string" &&
          n.data.config.actionType.startsWith(SUPERFLUID_PREFIX)
      );

      for (const node of superfluidActions) {
        const config = node.data.config;
        const slug = (config.actionType as string).slice(
          SUPERFLUID_PREFIX.length
        );

        describe(`action node ${node.id} (${slug})`, () => {
          const action = superfluidDef.actions.find((a) => a.slug === slug);

          it("references a declared Superfluid action", () => {
            expect(action).toBeDefined();
          });

          it("network is a Superfluid-supported chain ID", () => {
            expect(config.network).toBeTypeOf("string");
            expect(SUPPORTED_CHAINS).toContain(config.network);
          });

          it("_protocolMeta parses and matches the action definition", () => {
            if (!action) {
              return;
            }
            expect(typeof config._protocolMeta).toBe("string");
            const meta = JSON.parse(
              config._protocolMeta as string
            ) as ProtocolMeta;
            expect(meta.protocolSlug).toBe("superfluid");
            expect(meta.contractKey).toBe(action.contract);
            expect(meta.functionName).toBe(action.function);
            expect(meta.actionType).toBe(action.type);
          });

          it("required input fields are all present in config", () => {
            if (!action) {
              return;
            }
            const requiredInputs = action.inputs.filter(
              (inp) => inp.required ?? inp.default === undefined
            );
            for (const inp of requiredInputs) {
              expect(config).toHaveProperty(inp.name);
            }
          });
        });
      }
    });
  }
});
