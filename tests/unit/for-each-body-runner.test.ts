/**
 * Direct tests for `runBodyNode` (the pure For Each iteration body runner).
 *
 * These tests drive the *production* recursion logic with a mocked step
 * runner, so any change to executeBodyNode's behavior shows up here without
 * having to spin up the full Vercel Workflow runtime.
 *
 * Coverage targets the regression observed in execution
 * `2vv25od6mwq7etx68isv0` of workflow `ad25gf7g1pmmgmcuze96m` (Autoline
 * Job Keeper):
 *
 *   For Each (parallel, [MAKER, GELATO, KEEP3R])
 *     -> Sequencer (web3/read-contract)
 *     -> Condition "isMaster?" (true)
 *     -> AutoLineJob initial check (web3/read-contract, success)
 *     -> Decode autoline output (code/run-code)        <-- production stopped here
 *     -> Condition "IF workable is true"
 *     -> [Discord (false handle), DssAutoLine (true handle)]
 *     ...
 *
 * The MAKER iteration successfully ran AutoLineJob initial check and then
 * dropped the rest of the branch. These tests assert that runBodyNode does
 * NOT drop the branch under that exact shape.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { buildEdgesBySourceHandle } from "@/lib/workflow/editor/edge-handle-utils";
import { buildEdgesBySource } from "@/lib/workflow/executor/convergence-barrier";
import { identifyLoopBody } from "@/lib/workflow/executor/executor.workflow";
import {
  type BodyExecutionResult,
  type BodyNodeOutputs,
  type BodyStepRunner,
  type RunBodyContext,
  runBodyNode,
  type SpuriousRecoveryResolver,
} from "@/lib/workflow/executor/for-each-body-runner";
import type { StepContext } from "@/lib/workflow/executor/step-handler";
import type { WorkflowEdge, WorkflowNode } from "@/lib/workflow/store";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAction(
  id: string,
  actionType: string,
  label?: string
): WorkflowNode {
  return {
    id,
    type: "action",
    position: { x: 0, y: 0 },
    data: {
      type: "action",
      label: label ?? id,
      config: { actionType },
    },
  };
}

function makeCondition(id: string, label?: string): WorkflowNode {
  return makeAction(id, "Condition", label);
}

function makeForEach(id: string, label?: string): WorkflowNode {
  return makeAction(id, "For Each", label);
}

function edge(
  source: string,
  target: string,
  sourceHandle?: string
): WorkflowEdge {
  return {
    id: `${source}->${target}${sourceHandle ? `#${sourceHandle}` : ""}`,
    source,
    target,
    type: "default",
    ...(sourceHandle ? { sourceHandle } : {}),
  };
}

type StepResultFor = (nodeId: string) => unknown;

type RunIterationOptions = {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  forEachNodeId: string;
  iterationIndex?: number;
  stepResultFor: StepResultFor;
  /** Optional override for the step runner (defaults to one that calls
   *  stepResultFor and records calls). */
  stepRunner?: BodyStepRunner;
  /** KEEP-543: Optional resolver for spurious-max-retries recovery. */
  resolveSpuriousRecovery?: SpuriousRecoveryResolver;
  /** KEEP-543: Optional callback fired on successful recovery. */
  onSpuriousRecovery?: RunBodyContext["onSpuriousRecovery"];
};

type RunIterationOutcome = {
  bodyResults: Record<string, BodyExecutionResult>;
  scopedOutputs: BodyNodeOutputs;
  visitOrder: string[];
  callsByNode: Map<string, number>;
};

/**
 * Drive `runBodyNode` over a single iteration of the body. Mirrors the way
 * `handleForEachExecution` invokes runBodyNode in production.
 */
async function runIteration(
  options: RunIterationOptions
): Promise<RunIterationOutcome> {
  const {
    nodes,
    edges,
    forEachNodeId,
    iterationIndex = 0,
    stepResultFor,
  } = options;

  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const edgesBySource = buildEdgesBySource(edges);
  const fullHandleMap = buildEdgesBySourceHandle(edges);

  const { collectNodeId, bodyEdgesBySource, bodyEdgesBySourceHandle } =
    identifyLoopBody(forEachNodeId, edgesBySource, nodeMap, fullHandleMap);

  const bodyResults: Record<string, BodyExecutionResult> = {};
  const scopedOutputs: BodyNodeOutputs = {};
  const bodyVisited = new Set<string>();
  const visitOrder: string[] = [];
  const callsByNode = new Map<string, number>();

  const defaultStepRunner: BodyStepRunner = async ({ node, actionType }) => {
    visitOrder.push(node.id);
    callsByNode.set(node.id, (callsByNode.get(node.id) ?? 0) + 1);
    const result = stepResultFor(node.id);
    if (actionType === "Condition") {
      // The actual Condition step returns `{ condition: boolean }`.
      // Tests can return that shape directly via stepResultFor.
      return result;
    }
    return result;
  };

  const ctx: RunBodyContext = {
    nodeMap,
    bodyEdgesBySource,
    bodyEdgesBySourceHandle,
    collectNodeId,
    bodyVisited,
    bodyResults,
    scopedOutputs,
    iterationMeta: { iterationIndex, forEachNodeId },
    runStep: options.stepRunner ?? defaultStepRunner,
    resolveSpuriousRecovery: options.resolveSpuriousRecovery,
    onSpuriousRecovery: options.onSpuriousRecovery,
    processConfig: (config) => ({ ...config }),
    getNodeName: (n) => n.data.label || n.id,
    getErrorMessageAsync: async (err) =>
      err instanceof Error ? err.message : String(err),
    injectBuiltinVariables: () => {
      // No-op in tests
    },
    baseStepContext: {
      executionId: "exec-test",
      organizationId: "org-test",
      orgSlug: "org-test",
      createdBy: "user-test",
      workflowId: "wf-test",
    } satisfies Omit<StepContext, "nodeId" | "nodeName" | "nodeType">,
  };

  const firstBodyNodes = bodyEdgesBySource.get(forEachNodeId) ?? [];
  for (const bodyNodeId of firstBodyNodes) {
    await runBodyNode(bodyNodeId, ctx);
  }

  return { bodyResults, scopedOutputs, visitOrder, callsByNode };
}

// ===========================================================================
// 1. The Autoline Job Keeper regression: chain after a successful action
// ===========================================================================

describe("runBodyNode: production-shape Autoline Job Keeper iteration", () => {
  // For Each -> Sequencer -> Condition true -> AutoLineJob -> Decode
  //   -> IF workable -> [Discord (false), DssAutoLine (true)]
  //   DssAutoLine -> Condition -> Work
  const nodes = [
    makeForEach("for-each"),
    makeAction("sequencer", "web3/read-contract", "Sequencer"),
    makeCondition("c-master", "Sequencer is master?"),
    makeAction("autoline", "web3/read-contract", "AutoLineJob initial check"),
    makeAction("decode", "code/run-code", "Decode autoline output"),
    makeCondition("c-workable", "IF workable is true"),
    makeAction("discord", "discord/send-message", "Notify"),
    makeAction("dssAutoLine", "web3/read-contract", "DssAutoLine"),
    makeCondition("c-line", "line != 0"),
    makeAction("work", "web3/write-contract", "Call work()"),
  ];

  const edges = [
    edge("for-each", "sequencer", "loop"),
    edge("sequencer", "c-master"),
    edge("c-master", "autoline", "true"),
    edge("autoline", "decode"),
    edge("decode", "c-workable"),
    edge("c-workable", "discord", "false"),
    edge("c-workable", "dssAutoLine", "true"),
    edge("dssAutoLine", "c-line"),
    edge("c-line", "work", "true"),
  ];

  it("master=true, workable=true, line=true: traverses sequencer -> c-master -> autoline -> decode -> c-workable -> dssAutoLine -> c-line -> work", async () => {
    const { visitOrder, callsByNode, bodyResults } = await runIteration({
      nodes,
      edges,
      forEachNodeId: "for-each",
      stepResultFor: (nodeId) => {
        if (
          nodeId === "c-master" ||
          nodeId === "c-workable" ||
          nodeId === "c-line"
        ) {
          return { condition: true };
        }
        if (nodeId === "autoline") {
          return {
            success: true,
            result: { unnamedOutput0: true, unnamedOutput1: "0x" },
          };
        }
        return { success: true };
      },
    });

    expect(visitOrder).toEqual([
      "sequencer",
      "c-master",
      "autoline",
      "decode",
      "c-workable",
      "dssAutoLine",
      "c-line",
      "work",
    ]);
    expect(callsByNode.get("decode")).toBe(1);
    expect(bodyResults.decode?.success).toBe(true);
    expect(bodyResults.work?.success).toBe(true);
  });

  it("master=true, workable=false: takes Discord (false handle) and skips DssAutoLine", async () => {
    const { visitOrder, callsByNode } = await runIteration({
      nodes,
      edges,
      forEachNodeId: "for-each",
      stepResultFor: (nodeId) => {
        if (nodeId === "c-master") {
          return { condition: true };
        }
        if (nodeId === "c-workable") {
          return { condition: false };
        }
        if (nodeId === "autoline") {
          return {
            success: true,
            result: {
              unnamedOutput0: false,
              unnamedOutput1: "0x4e6f20696c6b73207265616479",
            },
          };
        }
        return { success: true };
      },
    });

    // Critical regression assertion: production stopped at "autoline" but the
    // run-code "decode" node MUST execute.
    expect(visitOrder).toContain("autoline");
    expect(visitOrder).toContain("decode");
    expect(visitOrder).toContain("c-workable");
    expect(visitOrder).toContain("discord");
    expect(visitOrder).not.toContain("dssAutoLine");
    expect(visitOrder).not.toContain("work");
    expect(callsByNode.get("decode")).toBe(1);
    expect(callsByNode.get("discord")).toBe(1);
  });

  it("master=false: chain stops at the master condition, autoline never runs", async () => {
    const { visitOrder, callsByNode } = await runIteration({
      nodes,
      edges,
      forEachNodeId: "for-each",
      stepResultFor: (nodeId) => {
        if (nodeId === "c-master") {
          return { condition: false };
        }
        return { success: true };
      },
    });

    expect(visitOrder).toEqual(["sequencer", "c-master"]);
    expect(callsByNode.get("autoline")).toBeUndefined();
    expect(callsByNode.get("decode")).toBeUndefined();
  });

  it("autoline returns success: false: stops the branch and downstream actions do not run", async () => {
    const { visitOrder, bodyResults } = await runIteration({
      nodes,
      edges,
      forEachNodeId: "for-each",
      stepResultFor: (nodeId) => {
        if (nodeId === "c-master") {
          return { condition: true };
        }
        if (nodeId === "autoline") {
          return { success: false, error: "RPC down" };
        }
        return { success: true };
      },
    });

    expect(visitOrder).toContain("autoline");
    expect(visitOrder).not.toContain("decode");
    expect(bodyResults.autoline?.success).toBe(false);
    expect(bodyResults.autoline?.error).toBe("RPC down");
  });
});

// ===========================================================================
// 2. Plain action chains (no conditions)
// ===========================================================================

describe("runBodyNode: pure action chains", () => {
  it("walks A -> B -> C in order", async () => {
    const nodes = [
      makeForEach("for-each"),
      makeAction("a", "web3/read-contract"),
      makeAction("b", "code/run-code"),
      makeAction("c", "discord/send-message"),
    ];
    const edges = [
      edge("for-each", "a", "loop"),
      edge("a", "b"),
      edge("b", "c"),
    ];

    const { visitOrder } = await runIteration({
      nodes,
      edges,
      forEachNodeId: "for-each",
      stepResultFor: () => ({ success: true }),
    });

    expect(visitOrder).toEqual(["a", "b", "c"]);
  });

  it("fans out to multiple downstream targets and visits each once", async () => {
    const nodes = [
      makeForEach("for-each"),
      makeAction("a", "web3/read-contract"),
      makeAction("b1", "code/run-code"),
      makeAction("b2", "code/run-code"),
      makeAction("b3", "discord/send-message"),
    ];
    const edges = [
      edge("for-each", "a", "loop"),
      edge("a", "b1"),
      edge("a", "b2"),
      edge("a", "b3"),
    ];

    const { visitOrder, callsByNode } = await runIteration({
      nodes,
      edges,
      forEachNodeId: "for-each",
      stepResultFor: () => ({ success: true }),
    });

    expect(visitOrder).toContain("a");
    expect(visitOrder).toContain("b1");
    expect(visitOrder).toContain("b2");
    expect(visitOrder).toContain("b3");
    expect(callsByNode.get("b1")).toBe(1);
    expect(callsByNode.get("b2")).toBe(1);
    expect(callsByNode.get("b3")).toBe(1);
  });

  it("dedupes a convergence target reached via two paths", async () => {
    const nodes = [
      makeForEach("for-each"),
      makeAction("a", "web3/read-contract"),
      makeCondition("gate"),
      makeAction("b1", "code/run-code"),
      makeAction("b2", "code/run-code"),
      makeAction("converge", "discord/send-message"),
    ];
    const edges = [
      edge("for-each", "a", "loop"),
      edge("a", "gate"),
      edge("gate", "b1", "true"),
      edge("gate", "b2", "false"),
      edge("b1", "converge"),
      edge("b2", "converge"),
    ];

    const { callsByNode } = await runIteration({
      nodes,
      edges,
      forEachNodeId: "for-each",
      stepResultFor: (nodeId) =>
        nodeId === "gate" ? { condition: true } : { success: true },
    });

    // bodyVisited dedupes within an iteration regardless of how many paths
    // reach the convergence node.
    expect(callsByNode.get("converge")).toBe(1);
  });

  it("propagates failure: stops the branch but leaves bodyResults reflecting the error", async () => {
    const nodes = [
      makeForEach("for-each"),
      makeAction("a", "web3/read-contract"),
      makeAction("b", "code/run-code"),
      makeAction("c", "discord/send-message"),
    ];
    const edges = [
      edge("for-each", "a", "loop"),
      edge("a", "b"),
      edge("b", "c"),
    ];

    const { visitOrder, bodyResults } = await runIteration({
      nodes,
      edges,
      forEachNodeId: "for-each",
      stepResultFor: (nodeId) =>
        nodeId === "b"
          ? { success: false, error: "explosion" }
          : { success: true },
    });

    expect(visitOrder).toEqual(["a", "b"]);
    expect(bodyResults.b?.success).toBe(false);
    expect(bodyResults.b?.error).toBe("explosion");
    expect(bodyResults.c).toBeUndefined();
  });
});

// ===========================================================================
// 3. Condition routing inside the body
// ===========================================================================

describe("runBodyNode: condition routing", () => {
  it("routes via the 'true' handle when condition is true", async () => {
    const nodes = [
      makeForEach("for-each"),
      makeCondition("gate"),
      makeAction("ok", "discord/send-message"),
      makeAction("bad", "code/run-code"),
    ];
    const edges = [
      edge("for-each", "gate", "loop"),
      edge("gate", "ok", "true"),
      edge("gate", "bad", "false"),
    ];

    const { visitOrder } = await runIteration({
      nodes,
      edges,
      forEachNodeId: "for-each",
      stepResultFor: (nodeId) =>
        nodeId === "gate" ? { condition: true } : { success: true },
    });

    expect(visitOrder).toEqual(["gate", "ok"]);
  });

  it("routes via the 'false' handle when condition is false", async () => {
    const nodes = [
      makeForEach("for-each"),
      makeCondition("gate"),
      makeAction("ok", "discord/send-message"),
      makeAction("bad", "code/run-code"),
    ];
    const edges = [
      edge("for-each", "gate", "loop"),
      edge("gate", "ok", "true"),
      edge("gate", "bad", "false"),
    ];

    const { visitOrder } = await runIteration({
      nodes,
      edges,
      forEachNodeId: "for-each",
      stepResultFor: (nodeId) =>
        nodeId === "gate" ? { condition: false } : { success: true },
    });

    expect(visitOrder).toEqual(["gate", "bad"]);
  });

  it("one-sided 'true' edge: condition=false skips everything downstream", async () => {
    const nodes = [
      makeForEach("for-each"),
      makeCondition("gate"),
      makeAction("only-true", "discord/send-message"),
    ];
    const edges = [
      edge("for-each", "gate", "loop"),
      edge("gate", "only-true", "true"),
    ];

    const { visitOrder } = await runIteration({
      nodes,
      edges,
      forEachNodeId: "for-each",
      stepResultFor: (nodeId) =>
        nodeId === "gate" ? { condition: false } : { success: true },
    });

    expect(visitOrder).toEqual(["gate"]);
  });

  it("chained conditions all true: walks the full chain", async () => {
    const nodes = [
      makeForEach("for-each"),
      makeCondition("c1"),
      makeCondition("c2"),
      makeCondition("c3"),
      makeAction("final", "discord/send-message"),
    ];
    const edges = [
      edge("for-each", "c1", "loop"),
      edge("c1", "c2", "true"),
      edge("c2", "c3", "true"),
      edge("c3", "final", "true"),
    ];

    const { visitOrder } = await runIteration({
      nodes,
      edges,
      forEachNodeId: "for-each",
      stepResultFor: () => ({ condition: true }),
    });

    expect(visitOrder).toEqual(["c1", "c2", "c3", "final"]);
  });
});

// ===========================================================================
// 4. Visit-set semantics
// ===========================================================================

describe("runBodyNode: bodyVisited semantics", () => {
  it("does not re-execute a node already in bodyVisited", async () => {
    const nodes = [
      makeForEach("for-each"),
      makeAction("a", "web3/read-contract"),
    ];
    const edges = [edge("for-each", "a", "loop")];
    const nodeMap = new Map(nodes.map((n) => [n.id, n]));
    const edgesBySource = buildEdgesBySource(edges);
    const fullHandleMap = buildEdgesBySourceHandle(edges);
    const { bodyEdgesBySource, bodyEdgesBySourceHandle, collectNodeId } =
      identifyLoopBody("for-each", edgesBySource, nodeMap, fullHandleMap);

    const callCount = vi.fn();
    const ctx: RunBodyContext = {
      nodeMap,
      bodyEdgesBySource,
      bodyEdgesBySourceHandle,
      collectNodeId,
      bodyVisited: new Set(["a"]), // <-- pre-marked
      bodyResults: {},
      scopedOutputs: {},
      iterationMeta: { iterationIndex: 0, forEachNodeId: "for-each" },
      runStep: async () => {
        callCount();
        return { success: true };
      },
      processConfig: (c) => ({ ...c }),
      getNodeName: (n) => n.data.label || n.id,
      getErrorMessageAsync: async (e) =>
        e instanceof Error ? e.message : String(e),
      injectBuiltinVariables: () => {
        // no-op
      },
      baseStepContext: {
        executionId: "e",
        organizationId: "o",
        orgSlug: "o",
        createdBy: "u",
        workflowId: "w",
      } satisfies Omit<StepContext, "nodeId" | "nodeName" | "nodeType">,
    };

    await runBodyNode("a", ctx);

    expect(callCount).not.toHaveBeenCalled();
  });

  it("does not execute the Collect boundary node", async () => {
    const nodes = [
      makeForEach("for-each"),
      makeAction("a", "web3/read-contract"),
      makeAction("collect", "Collect"),
    ];
    const edges = [edge("for-each", "a", "loop"), edge("a", "collect")];

    const callCount = vi.fn((id: string) => {
      // capture call ids
      return id;
    });

    const { visitOrder } = await runIteration({
      nodes,
      edges,
      forEachNodeId: "for-each",
      stepResultFor: (id) => {
        callCount(id);
        return { success: true };
      },
    });

    expect(visitOrder).toEqual(["a"]);
    expect(visitOrder).not.toContain("collect");
  });
});

// ===========================================================================
// 5. Disabled nodes
// ===========================================================================

describe("runBodyNode: disabled nodes", () => {
  it("skips a disabled node but continues to its downstream targets", async () => {
    const a = makeAction("a", "web3/read-contract");
    a.data.enabled = false;
    const nodes = [
      makeForEach("for-each"),
      a,
      makeAction("b", "code/run-code"),
    ];
    const edges = [edge("for-each", "a", "loop"), edge("a", "b")];

    const { visitOrder, scopedOutputs } = await runIteration({
      nodes,
      edges,
      forEachNodeId: "for-each",
      stepResultFor: () => ({ success: true }),
    });

    expect(visitOrder).toEqual(["b"]);
    // Disabled node still gets a null-data scopedOutputs entry.
    expect(scopedOutputs.a).toEqual({ label: "a", data: null });
  });
});

// ===========================================================================
// 6. Misconfigured action node
// ===========================================================================

describe("runBodyNode: missing actionType", () => {
  it("records a failure result when actionType is missing", async () => {
    const node: WorkflowNode = {
      id: "broken",
      type: "action",
      position: { x: 0, y: 0 },
      data: { type: "action", label: "broken", config: {} },
    };
    const nodes = [makeForEach("for-each"), node];
    const edges = [edge("for-each", "broken", "loop")];

    const { bodyResults } = await runIteration({
      nodes,
      edges,
      forEachNodeId: "for-each",
      stepResultFor: () => ({ success: true }),
    });

    expect(bodyResults.broken?.success).toBe(false);
    expect(bodyResults.broken?.error).toContain("no action type configured");
  });
});

// ===========================================================================
// 7. Step context plumbing
// ===========================================================================

describe("runBodyNode: step context", () => {
  it("plumbs iterationIndex and forEachNodeId into the step context", async () => {
    const nodes = [makeForEach("outer"), makeAction("a", "web3/read-contract")];
    const edges = [edge("outer", "a", "loop")];

    let observed: StepContext | undefined;
    await runIteration({
      nodes,
      edges,
      forEachNodeId: "outer",
      iterationIndex: 7,
      stepResultFor: () => ({ success: true }),
      stepRunner: async ({ stepContext }) => {
        observed = stepContext;
        return { success: true };
      },
    });

    expect(observed?.iterationIndex).toBe(7);
    expect(observed?.forEachNodeId).toBe("outer");
    expect(observed?.nodeId).toBe("a");
    expect(observed?.nodeType).toBe("web3/read-contract");
    expect(observed?.executionId).toBe("exec-test");
    expect(observed?.organizationId).toBe("org-test");
  });
});

// ===========================================================================
// KEEP-543: Spurious-max-retries recovery inside a For Each iteration
// ===========================================================================

const SPURIOUS_ERROR_REGEX = /exceeded max retries/;

describe("runBodyNode: KEEP-543 / KEEP-586 authority-backed recovery", () => {
  // For Each -> read -> decode (a plain action chain)
  const baseNodes = [
    makeForEach("for-each"),
    makeAction("read", "web3/read-contract", "Read contract"),
    makeAction("decode", "code/run-code", "Decode"),
  ];
  const baseEdges = [edge("for-each", "read", "loop"), edge("read", "decode")];

  it("treats a recovered spurious failure as success and continues downstream", async () => {
    const recoveredOutput = { result: { ceiling: 999 } };

    const throwingRunner: BodyStepRunner = ({ node }) => {
      if (node.id === "read") {
        return Promise.reject(
          new Error(
            'Step "step//./plugins/web3/steps/read-contract//readContractStep" exceeded max retries (1 retry)'
          )
        );
      }
      return Promise.resolve({ decoded: true });
    };

    const onRecovery = vi.fn();
    const { bodyResults, scopedOutputs } = await runIteration({
      nodes: baseNodes,
      edges: baseEdges,
      forEachNodeId: "for-each",
      iterationIndex: 3,
      stepResultFor: () => undefined,
      stepRunner: throwingRunner,
      resolveSpuriousRecovery: ({ nodeId, iterationMeta }) => {
        if (nodeId === "read" && iterationMeta.iterationIndex === 3) {
          return Promise.resolve({ output: recoveredOutput });
        }
        return Promise.resolve(null);
      },
      onSpuriousRecovery: onRecovery,
    });

    expect(bodyResults.read).toEqual({
      success: true,
      data: recoveredOutput,
    });
    expect(scopedOutputs.read?.data).toEqual(recoveredOutput);

    // Downstream decode ran on the recovered output.
    expect(bodyResults.decode).toEqual({
      success: true,
      data: { decoded: true },
    });

    expect(onRecovery).toHaveBeenCalledOnce();
    expect(onRecovery).toHaveBeenCalledWith({
      nodeId: "read",
      iterationMeta: { iterationIndex: 3, forEachNodeId: "for-each" },
      reason: "spurious_max_retries",
    });
  });

  it("recovers a long step abandoned with a non-max-retries error after its body completed", async () => {
    const recoveredOutput = { events: [{ blockNumber: 1 }] };
    const onRecovery = vi.fn();

    // The web3 event scan ran to completion (its success row is persisted) but
    // the runtime abandoned the step lease and threw a generic timeout error.
    const throwingRunner: BodyStepRunner = ({ node }) => {
      if (node.id === "read") {
        return Promise.reject(new Error("Step timed out after 60000ms"));
      }
      return Promise.resolve({ decoded: true });
    };

    const { bodyResults } = await runIteration({
      nodes: baseNodes,
      edges: baseEdges,
      forEachNodeId: "for-each",
      iterationIndex: 7,
      stepResultFor: () => undefined,
      stepRunner: throwingRunner,
      resolveSpuriousRecovery: ({ nodeId }) =>
        nodeId === "read"
          ? Promise.resolve({ output: recoveredOutput })
          : Promise.resolve(null),
      onSpuriousRecovery: onRecovery,
    });

    expect(bodyResults.read).toEqual({ success: true, data: recoveredOutput });
    // The downstream node now runs instead of the iteration silently stopping.
    expect(bodyResults.decode).toEqual({
      success: true,
      data: { decoded: true },
    });
    expect(onRecovery).toHaveBeenCalledWith({
      nodeId: "read",
      iterationMeta: { iterationIndex: 7, forEachNodeId: "for-each" },
      reason: "abandoned_completion",
    });
  });

  it("falls through to standard failure when resolver returns null", async () => {
    const throwingRunner: BodyStepRunner = ({ node }) => {
      if (node.id === "read") {
        return Promise.reject(
          new Error('Step "..." exceeded max retries (1 retry)')
        );
      }
      return Promise.resolve({ decoded: true });
    };

    const onRecovery = vi.fn();
    const { bodyResults } = await runIteration({
      nodes: baseNodes,
      edges: baseEdges,
      forEachNodeId: "for-each",
      stepResultFor: () => undefined,
      stepRunner: throwingRunner,
      resolveSpuriousRecovery: () => Promise.resolve(null),
      onSpuriousRecovery: onRecovery,
    });

    expect(bodyResults.read?.success).toBe(false);
    expect(bodyResults.read?.error).toMatch(SPURIOUS_ERROR_REGEX);
    expect(bodyResults.decode).toBeUndefined();
    expect(onRecovery).not.toHaveBeenCalled();
  });

  it("consults the authority for any error but fails when no success row exists", async () => {
    const realErrorRunner: BodyStepRunner = ({ node }) => {
      if (node.id === "read") {
        return Promise.reject(new Error("RPC connection refused"));
      }
      return Promise.resolve({ decoded: true });
    };

    // A genuinely failed step has no success row, so the resolver returns null
    // and the branch must still fail -- recovery never masks a real failure.
    const resolver = vi.fn(() => Promise.resolve(null));
    const { bodyResults } = await runIteration({
      nodes: baseNodes,
      edges: baseEdges,
      forEachNodeId: "for-each",
      stepResultFor: () => undefined,
      stepRunner: realErrorRunner,
      resolveSpuriousRecovery: resolver,
    });

    expect(resolver).toHaveBeenCalledOnce();
    expect(bodyResults.read?.success).toBe(false);
    expect(bodyResults.read?.error).toBe("RPC connection refused");
    expect(bodyResults.decode).toBeUndefined();
  });

  it("matches FAILED_AFTER_RETRIES_REGEX and NO_STEP_COMPLETION_REGEX patterns", async () => {
    const messages = [
      'Step "x" failed after 1 retries: boom',
      "Step did not record completion in time",
    ];

    for (const msg of messages) {
      const runner: BodyStepRunner = ({ node }) => {
        if (node.id === "read") {
          return Promise.reject(new Error(msg));
        }
        return Promise.resolve(null);
      };

      const { bodyResults } = await runIteration({
        nodes: baseNodes,
        edges: baseEdges,
        forEachNodeId: "for-each",
        stepResultFor: () => undefined,
        stepRunner: runner,
        resolveSpuriousRecovery: () =>
          Promise.resolve({ output: { recovered: msg } }),
      });

      expect(bodyResults.read).toEqual({
        success: true,
        data: { recovered: msg },
      });
    }
  });

  it("recovers Condition node and routes via the recovered handle", async () => {
    const nodes = [
      makeForEach("for-each"),
      makeCondition("c-master", "isMaster?"),
      makeAction("then-true", "web3/read-contract", "True branch"),
      makeAction("then-false", "discord/send-message", "False branch"),
    ];
    const edges = [
      edge("for-each", "c-master", "loop"),
      edge("c-master", "then-true", "true"),
      edge("c-master", "then-false", "false"),
    ];

    const runner: BodyStepRunner = ({ node }) => {
      if (node.id === "c-master") {
        return Promise.reject(
          new Error('Step "conditionStep" exceeded max retries (1 retry)')
        );
      }
      return Promise.resolve({ ok: true });
    };

    const { bodyResults } = await runIteration({
      nodes,
      edges,
      forEachNodeId: "for-each",
      stepResultFor: () => undefined,
      stepRunner: runner,
      resolveSpuriousRecovery: () =>
        Promise.resolve({ output: { condition: true } }),
    });

    expect(bodyResults["c-master"]).toEqual({
      success: true,
      data: { condition: true },
    });
    expect(bodyResults["then-true"]).toEqual({
      success: true,
      data: { ok: true },
    });
    expect(bodyResults["then-false"]).toBeUndefined();
  });

  it("no-ops when resolveSpuriousRecovery is not provided (defaults match legacy)", async () => {
    const runner: BodyStepRunner = ({ node }) => {
      if (node.id === "read") {
        return Promise.reject(
          new Error('Step "x" exceeded max retries (1 retry)')
        );
      }
      return Promise.resolve(null);
    };

    const { bodyResults } = await runIteration({
      nodes: baseNodes,
      edges: baseEdges,
      forEachNodeId: "for-each",
      stepResultFor: () => undefined,
      stepRunner: runner,
      // No resolveSpuriousRecovery passed
    });

    expect(bodyResults.read?.success).toBe(false);
    expect(bodyResults.decode).toBeUndefined();
  });
});
