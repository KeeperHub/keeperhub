import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  buildWorkflowExportV1,
  stripIntegrationsFromImportNodes,
} from "@/lib/workflow/export-schema";

/**
 * Exporting a workflow and importing it elsewhere, with PagerDuty nodes in it.
 *
 * Two things have to survive the trip and one has to not. The `{{...}}`
 * references and the bare node id the resolve action stores both point at node
 * ids, so they survive exactly as long as the ids do - import keeps them,
 * which is what makes the round trip reusable. The connection ids do not
 * survive, because they belong to the organisation that did the exporting.
 */
const TRIGGER_NODE = "node-page";
const CHECK_NODE = "node-check";

function pagerDutyWorkflow() {
  return {
    nodes: [
      {
        id: CHECK_NODE,
        type: "action",
        position: { x: 0, y: 0 },
        data: {
          label: "Check Vault",
          type: "action",
          config: {
            actionType: "web3/read-contract",
            integrationId: "int-rpc",
          },
        },
      },
      {
        id: TRIGGER_NODE,
        type: "action",
        position: { x: 0, y: 120 },
        data: {
          label: "Page on-call",
          type: "action",
          config: {
            actionType: "pagerduty/trigger-incident",
            integrationId: "int-pagerduty",
            pagerdutyServiceId: "PSVC1",
            // The references the question is about, in three shapes: a whole
            // value, one embedded in a sentence, and one inside JSON.
            summary: "Vault {{@node-check:Check Vault.id}} stalled",
            source: "{{@node-check:Check Vault.chain}}",
            customDetails:
              '{ "vault": "{{@node-check:Check Vault.address}}", "block": "{{@node-check:Check Vault.block}}" }',
            links:
              "Etherscan | https://etherscan.io/tx/{{@node-check:Check Vault.hash}}",
            backupIntegrationId: "int-discord",
            backupDestination: "#alerts",
          },
        },
      },
      {
        id: "node-resolve",
        type: "action",
        position: { x: 0, y: 240 },
        data: {
          label: "Close the page",
          type: "action",
          config: {
            actionType: "pagerduty/resolve-incident",
            integrationId: "int-pagerduty",
            pagerdutyServiceId: "PSVC1",
            // Not a template: a bare node id, which is the whole reason the
            // resolve works on the branch where the trigger never ran.
            dedupKeyFromNodeId: TRIGGER_NODE,
          },
        },
      },
    ],
    edges: [{ id: "e1", source: CHECK_NODE, target: TRIGGER_NODE }],
  };
}

function exportThenImport() {
  const workflow = pagerDutyWorkflow();
  const exported = buildWorkflowExportV1({
    name: "Vault health",
    description: "",
    nodes: workflow.nodes as never,
    edges: workflow.edges as never,
  });
  const imported = stripIntegrationsFromImportNodes(exported.nodes);
  return { exported, imported };
}

function configOf(nodes: Record<string, unknown>[], id: string) {
  const node = nodes.find((one) => one.id === id) as
    | { data: { config: Record<string, unknown> } }
    | undefined;
  return node?.data.config ?? {};
}

describe("exporting and importing a workflow with PagerDuty nodes", () => {
  it("keeps every node id, which is what every reference hangs on", () => {
    const { exported, imported } = exportThenImport();
    expect(exported.nodes.map((node) => node.id)).toEqual([
      CHECK_NODE,
      TRIGGER_NODE,
      "node-resolve",
    ]);
    expect(imported.map((node) => node.id)).toEqual([
      CHECK_NODE,
      TRIGGER_NODE,
      "node-resolve",
    ]);
  });

  it("carries {{...}} references through untouched, in every shape", () => {
    const { imported } = exportThenImport();
    const config = configOf(imported, TRIGGER_NODE);

    expect(config.summary).toBe("Vault {{@node-check:Check Vault.id}} stalled");
    expect(config.source).toBe("{{@node-check:Check Vault.chain}}");
    expect(config.customDetails).toBe(
      '{ "vault": "{{@node-check:Check Vault.address}}", "block": "{{@node-check:Check Vault.block}}" }'
    );
    expect(config.links).toBe(
      "Etherscan | https://etherscan.io/tx/{{@node-check:Check Vault.hash}}"
    );
  });

  /**
   * The bare node id is the one that a remap would have to know about, and the
   * reason it needs no remap here is that import keeps ids. It is also why a
   * duplicate, which does regenerate them, had to learn to rewrite it.
   */
  it("keeps the resolve pointing at the trigger it closes", () => {
    const { imported } = exportThenImport();
    expect(configOf(imported, "node-resolve").dedupKeyFromNodeId).toBe(
      TRIGGER_NODE
    );
    // And that node is still in the workflow it was imported with.
    expect(imported.some((node) => node.id === TRIGGER_NODE)).toBe(true);
  });

  it("keeps the PagerDuty service id, which the importer's picker checks", () => {
    const { imported } = exportThenImport();
    expect(configOf(imported, TRIGGER_NODE).pagerdutyServiceId).toBe("PSVC1");
  });

  /**
   * An export is a file people pass around. `integrationId` was always
   * stripped; `backupIntegrationId` is a second connection id, on a field
   * whose type says so, and it belongs to the exporting organisation just as
   * much.
   */
  it("strips every connection id, not only the obvious one", () => {
    const { exported, imported } = exportThenImport();
    for (const nodes of [
      exported.nodes as unknown as Record<string, unknown>[],
      imported,
    ]) {
      const config = configOf(nodes, TRIGGER_NODE);
      expect(config.integrationId).toBeUndefined();
      expect(config.backupIntegrationId).toBeUndefined();
      // What is not a credential stays: the importer keeps their wiring.
      expect(config.backupDestination).toBe("#alerts");
    }
  });
});
