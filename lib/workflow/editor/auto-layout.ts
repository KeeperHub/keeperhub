import { partitionByBackEdges } from "@/lib/workflow/editor/back-edges";

// Local structural types instead of importing @xyflow/react, so this pure
// layout helper can also run server-side (e.g. seeding onboarding workflow
// fixtures). Real @xyflow/react Node/Edge are structural supersets, so editor
// callers pass them without a cast.
type Node = {
  id: string;
  type?: string;
  position: { x: number; y: number };
};
type Edge = {
  source: string;
  target: string;
  sourceHandle?: string | null;
};

const NODE_WIDTH = 192;
const NODE_HEIGHT = 192;
const H_GAP = 60;
const V_GAP = 40;

function buildGraph(
  realNodes: Node[],
  forwardEdges: Edge[]
): { outEdges: Map<string, Edge[]>; inDegree: Map<string, number> } {
  const outEdges = new Map<string, Edge[]>();
  const inDegree = new Map<string, number>();

  for (const node of realNodes) {
    outEdges.set(node.id, []);
    inDegree.set(node.id, 0);
  }

  for (const edge of forwardEdges) {
    const out = outEdges.get(edge.source);
    if (out) {
      out.push(edge);
    }
    inDegree.set(edge.target, (inDegree.get(edge.target) ?? 0) + 1);
  }

  return { outEdges, inDegree };
}

function findRoots(realNodes: Node[], inDegree: Map<string, number>): string[] {
  const roots: string[] = [];
  const triggerNode = realNodes.find((n) => n.type === "trigger");

  if (triggerNode && inDegree.get(triggerNode.id) === 0) {
    roots.push(triggerNode.id);
  }

  for (const node of realNodes) {
    if (inDegree.get(node.id) === 0 && !roots.includes(node.id)) {
      roots.push(node.id);
    }
  }

  return roots;
}

/**
 * Assign columns using longest-path from roots (topological order).
 */
function assignColumns(
  roots: string[],
  outEdges: Map<string, Edge[]>,
  inDegree: Map<string, number>
): Map<string, number> {
  const column = new Map<string, number>();
  const remaining = new Map<string, number>();

  for (const [id, deg] of inDegree) {
    remaining.set(id, deg);
  }

  const queue: string[] = [];
  for (const root of roots) {
    column.set(root, 0);
    queue.push(root);
  }

  let head = 0;
  while (head < queue.length) {
    const current = queue[head++];
    const currentCol = column.get(current) ?? 0;

    for (const edge of outEdges.get(current) ?? []) {
      const child = edge.target;
      const newCol = currentCol + 1;
      const existing = column.get(child);
      if (existing === undefined || newCol > existing) {
        column.set(child, newCol);
      }

      const rem = (remaining.get(child) ?? 1) - 1;
      remaining.set(child, rem);
      if (rem <= 0) {
        queue.push(child);
      }
    }
  }

  return column;
}

/**
 * Sort outgoing edges: true/loop first, normal middle, false/done last.
 */
function sortedChildren(
  nodeId: string,
  outEdges: Map<string, Edge[]>
): string[] {
  const edges = outEdges.get(nodeId) ?? [];
  const top: string[] = [];
  const normal: string[] = [];
  const bottom: string[] = [];
  const seen = new Set<string>();

  for (const edge of edges) {
    // Skip duplicate edges (same source->target)
    if (seen.has(edge.target)) {
      continue;
    }
    seen.add(edge.target);

    const handle = edge.sourceHandle;
    if (handle === "true" || handle === "loop") {
      top.push(edge.target);
    } else if (handle === "false" || handle === "done") {
      bottom.push(edge.target);
    } else {
      normal.push(edge.target);
    }
  }

  return [...top, ...normal, ...bottom];
}

const STEP_Y = NODE_HEIGHT + V_GAP;

/**
 * Compute how many vertical rows a node's subtree needs.
 * - Leaf: 1
 * - Linear (1 child): propagates child's spread (so downstream branches
 *   are accounted for at all ancestor levels, preventing overlap)
 * - Branching (N children): sum of owned children's spreads
 *   (convergence children that were already visited contribute 0)
 * - Already-visited (convergence): 0 (don't double-count)
 */
function computeSpread(
  nodeId: string,
  outEdges: Map<string, Edge[]>,
  visited: Set<string>,
  spreadMap: Map<string, number>
): number {
  if (visited.has(nodeId)) {
    return 0;
  }
  visited.add(nodeId);

  const children = sortedChildren(nodeId, outEdges);

  if (children.length === 0) {
    spreadMap.set(nodeId, 1);
    return 1;
  }

  if (children.length === 1) {
    const childSpread = computeSpread(
      children[0],
      outEdges,
      visited,
      spreadMap
    );
    const spread = Math.max(1, childSpread);
    spreadMap.set(nodeId, spread);
    return spread;
  }

  // Branching: sum only owned children (convergence children contribute 0)
  let total = 0;
  for (const child of children) {
    total += computeSpread(child, outEdges, visited, spreadMap);
  }
  const spread = Math.max(total, 1);
  spreadMap.set(nodeId, spread);
  return spread;
}

type PlacementCtx = {
  positions: Map<string, { x: number; y: number }>;
  placed: Set<string>;
  columns: Map<string, number>;
  outEdges: Map<string, Edge[]>;
  spreadMap: Map<string, number>;
};

/**
 * Place a list of nodes vertically, centered around centerY,
 * using each node's subtree spread to allocate space.
 */
function spreadNodes(
  nodeIds: string[],
  centerY: number,
  ctx: PlacementCtx
): void {
  const spreads: number[] = [];
  let totalSpread = 0;
  for (const id of nodeIds) {
    const s = ctx.spreadMap.get(id) ?? 1;
    spreads.push(s);
    totalSpread += s;
  }

  let y = centerY - ((totalSpread - 1) * STEP_Y) / 2;
  for (let i = 0; i < nodeIds.length; i++) {
    const id = nodeIds[i];
    const s = spreads[i];
    const nodeCenterY = y + ((s - 1) * STEP_Y) / 2;
    const col = ctx.columns.get(id) ?? 0;
    ctx.positions.set(id, { x: col * (NODE_WIDTH + H_GAP), y: nodeCenterY });
    ctx.placed.add(id);
    y += s * STEP_Y;
  }
}

/**
 * Check if a node has branch handles (true/false/done/loop) on its edges.
 * Used to determine phantom centering behavior.
 */
function hasBranchHandles(
  nodeId: string,
  outEdges: Map<string, Edge[]>
): boolean {
  for (const edge of outEdges.get(nodeId) ?? []) {
    const h = edge.sourceHandle;
    if (h === "true" || h === "false" || h === "done" || h === "loop") {
      return true;
    }
  }
  return false;
}

/**
 * Compute immediate spread for a child: 1 for linear, full spread for branching.
 */
function childPlacementSpread(
  childId: string,
  outEdges: Map<string, Edge[]>,
  spreadMap: Map<string, number>
): number {
  const edgeCount = (outEdges.get(childId) ?? []).length;
  return edgeCount > 1 ? (spreadMap.get(childId) ?? 1) : 1;
}

/**
 * Place children of a single parent node.
 * - 1 effective child: linear, shares parent Y
 * - 2+ effective children: centered around parent Y.
 *   For branch nodes (true/false handles): ALL children used for centering
 *   (phantoms for already-placed) so true goes above, false below.
 *   For normal nodes: only unplaced children centered around parent.
 */
function placeChildrenOf(parentId: string, ctx: PlacementCtx): void {
  const parentPos = ctx.positions.get(parentId);
  if (!parentPos) {
    return;
  }

  const allChildren = sortedChildren(parentId, ctx.outEdges);
  const unplaced = allChildren.filter((c) => !ctx.placed.has(c));

  if (unplaced.length === 0) {
    return;
  }

  // Branch nodes (true/false handles): use ALL children for centering (phantoms)
  // Normal nodes: only center unplaced children
  const isBranch = hasBranchHandles(parentId, ctx.outEdges);
  const childrenToCenter = isBranch ? allChildren : unplaced;

  // Single effective child: linear, share parent Y
  if (childrenToCenter.length <= 1) {
    const child = unplaced[0];
    const col = ctx.columns.get(child) ?? 0;
    ctx.positions.set(child, {
      x: col * (NODE_WIDTH + H_GAP),
      y: parentPos.y,
    });
    ctx.placed.add(child);
    return;
  }

  // 2+ children: centered around parent Y.
  // Linear children get spread=1 for even spacing.
  // Branching children get their full subtree spread.
  const spreads: number[] = [];
  let totalSpread = 0;
  for (const id of childrenToCenter) {
    const s = childPlacementSpread(id, ctx.outEdges, ctx.spreadMap);
    spreads.push(s);
    totalSpread += s;
  }

  let y = parentPos.y - ((totalSpread - 1) * STEP_Y) / 2;
  for (let i = 0; i < childrenToCenter.length; i++) {
    const child = childrenToCenter[i];
    const s = spreads[i];
    const centerY = y + ((s - 1) * STEP_Y) / 2;
    if (!ctx.placed.has(child)) {
      const col = ctx.columns.get(child) ?? 0;
      ctx.positions.set(child, {
        x: col * (NODE_WIDTH + H_GAP),
        y: centerY,
      });
      ctx.placed.add(child);
    }
    y += s * STEP_Y;
  }
}

/**
 * Place nodes level by level (column by column), left to right.
 * Each parent spreads its children vertically based on their subtree spread.
 */
function placeLevelByLevel(
  roots: string[],
  columns: Map<string, number>,
  outEdges: Map<string, Edge[]>,
  spreadMap: Map<string, number>
): Map<string, { x: number; y: number }> {
  const ctx: PlacementCtx = {
    positions: new Map(),
    placed: new Set(),
    columns,
    outEdges,
    spreadMap,
  };

  let maxCol = 0;
  for (const col of columns.values()) {
    if (col > maxCol) {
      maxCol = col;
    }
  }

  // Place roots centered around y=0
  spreadNodes(roots, 0, ctx);

  // Process columns left to right
  for (let col = 0; col <= maxCol; col++) {
    for (const [nodeId, nodeCol] of columns) {
      if (nodeCol === col && ctx.placed.has(nodeId)) {
        placeChildrenOf(nodeId, ctx);
      }
    }
  }

  return ctx.positions;
}

/**
 * Build parent map from forward edges.
 */
function buildParentMap(forwardEdges: Edge[]): Map<string, string[]> {
  const parents = new Map<string, string[]>();
  for (const edge of forwardEdges) {
    const p = parents.get(edge.target);
    if (p) {
      if (!p.includes(edge.source)) {
        p.push(edge.source);
      }
    } else {
      parents.set(edge.target, [edge.source]);
    }
  }
  return parents;
}

/**
 * Check if all parents of a node are in the same column (siblings).
 */
function areParentsSiblings(
  nodeParents: string[],
  columns: Map<string, number>
): boolean {
  const firstCol = columns.get(nodeParents[0]);
  for (const p of nodeParents) {
    if (columns.get(p) !== firstCol) {
      return false;
    }
  }
  return true;
}

/**
 * Compute the average Y position of a list of parent nodes.
 * Returns undefined if no parents have positions.
 */
function averageParentY(
  nodeParents: string[],
  positions: Map<string, { x: number; y: number }>
): number | undefined {
  let sumY = 0;
  let count = 0;
  for (const parentId of nodeParents) {
    const parentPos = positions.get(parentId);
    if (parentPos) {
      sumY += parentPos.y;
      count++;
    }
  }
  return count > 0 ? sumY / count : undefined;
}

/**
 * Center convergence nodes between their parents, but ONLY when all parents
 * are in the same column (siblings). Shifts uniquely-owned descendants
 * (inDegree=1) to avoid cascading through shared subtrees.
 */
function centerSiblingConvergence(
  positions: Map<string, { x: number; y: number }>,
  forwardEdges: Edge[],
  inDegree: Map<string, number>,
  columns: Map<string, number>,
  outEdges: Map<string, Edge[]>
): void {
  const parents = buildParentMap(forwardEdges);

  for (const [nodeId, degree] of inDegree) {
    if (degree <= 1) {
      continue;
    }

    const nodeParents = parents.get(nodeId);
    const pos = positions.get(nodeId);
    if (!(nodeParents && pos)) {
      continue;
    }

    if (!areParentsSiblings(nodeParents, columns)) {
      continue;
    }

    const targetY = averageParentY(nodeParents, positions);
    if (targetY === undefined) {
      continue;
    }

    const deltaY = targetY - pos.y;
    if (Math.abs(deltaY) < 1) {
      continue;
    }

    shiftOwned(nodeId, deltaY, positions, outEdges, inDegree, new Set());
  }
}

/**
 * Shift a node and its descendants that have inDegree=1 (uniquely owned).
 * Stops at convergence nodes to avoid cascading into shared subtrees.
 */
function shiftOwned(
  nodeId: string,
  deltaY: number,
  positions: Map<string, { x: number; y: number }>,
  outEdges: Map<string, Edge[]>,
  inDegree: Map<string, number>,
  visited: Set<string>
): void {
  if (visited.has(nodeId)) {
    return;
  }
  visited.add(nodeId);

  const pos = positions.get(nodeId);
  if (pos) {
    positions.set(nodeId, { x: pos.x, y: pos.y + deltaY });
  }

  for (const edge of outEdges.get(nodeId) ?? []) {
    const childDegree = inDegree.get(edge.target) ?? 0;
    if (childDegree <= 1) {
      shiftOwned(edge.target, deltaY, positions, outEdges, inDegree, visited);
    }
  }
}

/**
 * Compute a clean left-to-right DAG layout for workflow nodes.
 *
 * - Columns via longest-path topological sort (handles convergence)
 * - Rows via level-by-level forward sweep with subtree-spread sizing
 * - Edge ordering: true/loop on top, false/done on bottom
 * - Sibling convergence nodes centered between their parents
 */
export function computeAutoLayout(
  nodes: Node[],
  edges: Edge[]
): Map<string, { x: number; y: number }> {
  const realNodes = nodes.filter((n) => n.type !== "add");
  const realNodeIds = new Set(realNodes.map((n) => n.id));

  // Loop-back edges are dropped along with the For Each `loop` handle: both
  // point at a node the layout has already placed, and counting them toward its
  // in-degree leaves it waiting on an arrival the sweep never makes, so it and
  // everything behind it fall out of the columns into the disconnected pile.
  const layoutEdges = edges.filter(
    (e) =>
      realNodeIds.has(e.source) &&
      realNodeIds.has(e.target) &&
      e.sourceHandle !== "loop"
  );
  const { forwardEdges } = partitionByBackEdges(realNodes, layoutEdges);

  const graph = buildGraph(realNodes, forwardEdges);
  const roots = findRoots(realNodes, graph.inDegree);
  const columns = assignColumns(roots, graph.outEdges, graph.inDegree);

  // Phase 1: Compute subtree spreads (bottom-up)
  const spreadVisited = new Set<string>();
  const spreadMap = new Map<string, number>();
  for (const root of roots) {
    computeSpread(root, graph.outEdges, spreadVisited, spreadMap);
  }
  // Ensure disconnected nodes have spread computed
  for (const node of realNodes) {
    if (!spreadMap.has(node.id)) {
      computeSpread(node.id, graph.outEdges, spreadVisited, spreadMap);
    }
  }

  // Phase 2: Place nodes level by level
  const positions = placeLevelByLevel(
    roots,
    columns,
    graph.outEdges,
    spreadMap
  );

  // Place any unplaced nodes (disconnected)
  let maxY = 0;
  for (const pos of positions.values()) {
    if (pos.y > maxY) {
      maxY = pos.y;
    }
  }
  let nextUnplacedY = maxY + STEP_Y;
  for (const node of realNodes) {
    if (!positions.has(node.id)) {
      const col = columns.get(node.id) ?? 0;
      positions.set(node.id, {
        x: col * (NODE_WIDTH + H_GAP),
        y: nextUnplacedY,
      });
      nextUnplacedY += STEP_Y;
    }
  }

  // Phase 3: Center convergence nodes whose parents are siblings (same column)
  centerSiblingConvergence(
    positions,
    forwardEdges,
    graph.inDegree,
    columns,
    graph.outEdges
  );

  return positions;
}
