// A Write Contract bundle step, alone or in a For Each nested in another, for
// route tests that the save checks get the organization and the edges.

const ABI =
  '[{"type":"function","name":"run","inputs":[],"outputs":[],"stateMutability":"nonpayable"}]';

/** A bundle step on a templated network, so the save reads no chain rows. */
export function bundleStep(id = "write-1"): Record<string, unknown> {
  return {
    id,
    type: "action",
    position: { x: 0, y: 0 },
    data: {
      type: "action",
      label: "Write",
      config: {
        actionType: "web3/write-contract",
        network: "{{@trigger-1:Trigger.chainId}}",
        sendMode: "bundle",
        contractAddress: "0x000000000000000000000000000000000000dEaD",
        abi: ABI,
        abiFunction: "run",
      },
    },
  };
}

function forEach(id: string): Record<string, unknown> {
  return {
    id,
    type: "action",
    position: { x: 0, y: 0 },
    data: {
      type: "action",
      label: id,
      config: { actionType: "For Each", arraySource: "[1]" },
    },
  };
}

/** Two For Each loops, the bundle step in the inner one's body. */
export function nestedBundleWorkflow(): {
  nodes: Record<string, unknown>[];
  edges: Record<string, unknown>[];
} {
  return {
    nodes: [forEach("outer"), forEach("inner"), bundleStep()],
    edges: [
      { id: "e1", source: "outer", target: "inner", sourceHandle: "loop" },
      { id: "e2", source: "inner", target: "write-1", sourceHandle: "loop" },
    ],
  };
}

export const NOT_TURNED_ON = "is not turned on for this organization yet";
export const NESTED_LOOP =
  "cannot run inside a For Each that is inside another For Each";
