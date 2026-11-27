import { partitionByBackEdges } from "@/lib/workflow/editor/back-edges";
import { buildEdgesBySourceHandle } from "@/lib/workflow/editor/edge-handle-utils";
import { buildEdgesBySource } from "@/lib/workflow/executor/convergence-barrier";
import type { WorkflowEdge, WorkflowNode } from "@/lib/workflow/store";

type GraphNode = {
  id?: unknown;
  data?: { type?: unknown; config?: Record<string, unknown> };
};
type GraphEdge = { source?: unknown; target?: unknown; sourceHandle?: unknown };

// The loop helpers read only ids, data.type and data.config, and edge ends and
// handles: a node or edge with string ids is used as the executor's own type.
function isGraphNode(node: GraphNode): node is WorkflowNode {
  return typeof node.id === "string";
}

function isGraphEdge(edge: GraphEdge): edge is WorkflowEdge {
  return typeof edge.source === "string" && typeof edge.target === "string";
}

function isForEach(node: GraphNode): boolean {
  return (
    node.data?.type === "action" && node.data.config?.actionType === "For Each"
  );
}

/**
 * How many For Each loops each node runs inside, as the executor finds loop
 * bodies (1 in a top-level loop's body). Nodes in no loop are left out.
 */
export async function loopDepthsOf(
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[]
): Promise<Map<string, number>> {
  const graphNodes = nodes.filter(isGraphNode);
  const forEachIds = graphNodes.filter(isForEach).map((node) => node.id);
  if (forEachIds.length === 0) {
    return new Map();
  }
  const graphEdges = edges.filter(isGraphEdge);
  // Loaded only when a loop is present: the executor module is large.
  const { identifyLoopBody } = await import(
    "@/lib/workflow/executor/executor.workflow"
  );
  const nodeMap = new Map(graphNodes.map((node) => [node.id, node]));
  const { forwardEdges } = partitionByBackEdges(graphNodes, graphEdges);
  const forwardBySource = buildEdgesBySource(forwardEdges);
  const byHandle = buildEdgesBySourceHandle(graphEdges);

  const loopsAround = new Map<string, string[]>();
  for (const forEachId of forEachIds) {
    let body: string[] = [];
    try {
      body = identifyLoopBody(
        forEachId,
        forwardBySource,
        nodeMap,
        byHandle
      ).bodyNodeIds;
    } catch {
      // A mis-wired loop is reported when the run starts.
    }
    for (const id of body) {
      if (id !== forEachId) {
        loopsAround.set(id, [...(loopsAround.get(id) ?? []), forEachId]);
      }
    }
  }

  const depths = new Map<string, number>();
  const visiting = new Set<string>();
  const depthOf = (id: string): number => {
    const known = depths.get(id);
    if (known !== undefined) {
      return known;
    }
    if (visiting.has(id)) {
      return 0;
    }
    visiting.add(id);
    let depth = 0;
    for (const loopId of loopsAround.get(id) ?? []) {
      depth = Math.max(depth, depthOf(loopId) + 1);
    }
    visiting.delete(id);
    depths.set(id, depth);
    return depth;
  };
  for (const id of loopsAround.keys()) {
    depthOf(id);
  }
  return depths;
}
