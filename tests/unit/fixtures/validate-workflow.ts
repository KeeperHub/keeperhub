// Shared fixture builders for validate-workflow test files.
// Both validate-workflow-structural.test.ts and validate-workflow-web3.test.ts
// import from here to avoid duplicating >20 lines of setup.

import type { ValidatorWorkflow } from "@/lib/mcp/validate-workflow";

export const triggerNode = (id = "trigger-1") => ({
  id,
  type: "trigger",
  data: {
    label: "Trigger",
    type: "trigger",
    config: { triggerType: "Manual" },
  },
});

export const actionNode = (
  id = "action-1",
  overrides: Record<string, unknown> = {}
) => ({
  id,
  type: "action",
  data: {
    label: "Action",
    type: "action",
    config: { actionType: "web3/read-contract", ...overrides },
  },
});

export const writeActionNode = (id = "write-1") => ({
  id,
  type: "action",
  data: {
    label: "Write Contract",
    type: "action",
    config: {
      actionType: "web3/write-contract",
      contractAddress: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
      abi: "[]",
      abiFunction: "transfer",
    },
  },
});

export const edge = (id: string, source: string, target: string) => ({
  id,
  source,
  target,
});

export function makeWorkflow(
  overrides: Partial<ValidatorWorkflow> = {}
): ValidatorWorkflow {
  return {
    id: "wf-1",
    nodes: [triggerNode(), actionNode()],
    edges: [edge("e1", "trigger-1", "action-1")],
    inputSchema: { type: "object" },
    outputMapping: null,
    isListed: false,
    workflowType: "read",
    ...overrides,
  };
}

export function buildLargeWorkflowFixture(
  nodeCount: number
): ValidatorWorkflow {
  const nodes: unknown[] = [triggerNode("trigger-1")];
  const edges: unknown[] = [];
  let prev = "trigger-1";
  for (let i = 1; i < nodeCount; i++) {
    const id = `action-${i}`;
    nodes.push(actionNode(id));
    edges.push(edge(`e${i}`, prev, id));
    prev = id;
  }
  return {
    id: "wf-large",
    nodes,
    edges,
    inputSchema: { type: "object" },
    outputMapping: null,
    isListed: false,
    workflowType: "read",
  };
}
