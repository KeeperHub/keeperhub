import { sourceHandleRank } from "@/lib/workflow/source-handles";

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

const COLUMN_STEP = NODE_WIDTH + H_GAP;
const ROW_STEP = NODE_HEIGHT + V_GAP;

// An edge with no named handle sits between the upper and the lower handle.
const UNNAMED_RANK = 0.5;

/**
 * Order outgoing edges the way their handles sit on the node: the upper handle
 * (true, done) first, then edges with no named handle, then the lower one
 * (false, loop). Sorting is stable, so edges sharing a handle keep their order.
 */
function sortEdges(edges: Edge[]): Edge[] {
  return [...edges].sort(
    (a, b) =>
      (sourceHandleRank(a.sourceHandle) ?? UNNAMED_RANK) -
      (sourceHandleRank(b.sourceHandle) ?? UNNAMED_RANK)
  );
}

/** Walk the trigger first, then unreferenced nodes, then anything left on a cycle. */
function walkOrder(realNodes: Node[], targets: Set<string>): string[] {
  const start: string[] = [];
  const trigger = realNodes.find((n) => n.type === "trigger");
  if (trigger) {
    start.push(trigger.id);
  }
  for (const node of realNodes) {
    if (!(targets.has(node.id) || start.includes(node.id))) {
      start.push(node.id);
    }
  }
  for (const node of realNodes) {
    if (!start.includes(node.id)) {
      start.push(node.id);
    }
  }
  return start;
}

/**
 * Drop self edges, duplicates and back edges so the rest of the layout works on
 * a DAG. A back edge points at a node still open on the DFS stack, which is the
 * edge that closes a loop back onto its own body.
 */
function forwardEdgesOf(realNodes: Node[], edges: Edge[]): Edge[] {
  const realIds = new Set(realNodes.map((n) => n.id));
  const candidates: Edge[] = [];
  const seen = new Set<string>();
  const targets = new Set<string>();

  for (const edge of edges) {
    const key = `${edge.source}->${edge.target}`;
    if (
      edge.source === edge.target ||
      !(realIds.has(edge.source) && realIds.has(edge.target)) ||
      seen.has(key)
    ) {
      continue;
    }
    seen.add(key);
    candidates.push(edge);
    targets.add(edge.target);
  }

  const bySource = new Map<string, Edge[]>();
  for (const edge of candidates) {
    const list = bySource.get(edge.source);
    if (list) {
      list.push(edge);
    } else {
      bySource.set(edge.source, [edge]);
    }
  }

  const backEdges = new Set<string>();
  const open = new Set<string>();
  const done = new Set<string>();

  const visit = (nodeId: string): void => {
    open.add(nodeId);
    for (const edge of sortEdges(bySource.get(nodeId) ?? [])) {
      if (open.has(edge.target)) {
        backEdges.add(`${edge.source}->${edge.target}`);
      } else if (!done.has(edge.target)) {
        visit(edge.target);
      }
    }
    open.delete(nodeId);
    done.add(nodeId);
  };

  for (const nodeId of walkOrder(realNodes, targets)) {
    if (!done.has(nodeId)) {
      visit(nodeId);
    }
  }

  return candidates.filter((e) => !backEdges.has(`${e.source}->${e.target}`));
}

type Graph = {
  children: Map<string, string[]>;
  parents: Map<string, string[]>;
  inDegree: Map<string, number>;
  /** Edges that leave a named handle, keyed "source->target". */
  branchEdges: Set<string>;
};

function buildGraph(realNodes: Node[], forwardEdges: Edge[]): Graph {
  const children = new Map<string, string[]>();
  const parents = new Map<string, string[]>();
  const inDegree = new Map<string, number>();
  const branchEdges = new Set<string>();

  for (const node of realNodes) {
    children.set(node.id, []);
    parents.set(node.id, []);
    inDegree.set(node.id, 0);
  }

  const bySource = new Map<string, Edge[]>();
  for (const edge of forwardEdges) {
    const list = bySource.get(edge.source);
    if (list) {
      list.push(edge);
    } else {
      bySource.set(edge.source, [edge]);
    }
  }

  for (const node of realNodes) {
    for (const edge of sortEdges(bySource.get(node.id) ?? [])) {
      children.get(node.id)?.push(edge.target);
      parents.get(edge.target)?.push(node.id);
      inDegree.set(edge.target, (inDegree.get(edge.target) ?? 0) + 1);
      if (sourceHandleRank(edge.sourceHandle) !== undefined) {
        branchEdges.add(`${node.id}->${edge.target}`);
      }
    }
  }

  return { children, parents, inDegree, branchEdges };
}

function findRoots(realNodes: Node[], inDegree: Map<string, number>): string[] {
  const roots: string[] = [];
  const trigger = realNodes.find((n) => n.type === "trigger");

  if (trigger && inDegree.get(trigger.id) === 0) {
    roots.push(trigger.id);
  }

  for (const node of realNodes) {
    if (inDegree.get(node.id) === 0 && !roots.includes(node.id)) {
      roots.push(node.id);
    }
  }

  return roots;
}

/**
 * Assign columns using longest-path from roots (topological order), so a node
 * always sits to the right of every node that feeds it.
 */
function assignColumns(roots: string[], graph: Graph): Map<string, number> {
  const column = new Map<string, number>();
  const remaining = new Map(graph.inDegree);
  const queue = [...roots];

  for (const root of roots) {
    column.set(root, 0);
  }

  let head = 0;
  while (head < queue.length) {
    const current = queue[head++];
    const nextCol = (column.get(current) ?? 0) + 1;

    for (const child of graph.children.get(current) ?? []) {
      if (nextCol > (column.get(child) ?? Number.NEGATIVE_INFINITY)) {
        column.set(child, nextCol);
      }
      const rem = (remaining.get(child) ?? 1) - 1;
      remaining.set(child, rem);
      if (rem <= 0) {
        queue.push(child);
      }
    }
  }

  for (const node of graph.children.keys()) {
    if (!column.has(node)) {
      column.set(node, 0);
    }
  }

  return column;
}

/**
 * Pick one parent per node, so the graph reduces to a tree that can be given
 * tidy bands. A branch owns its target: a node reached from a named handle
 * hangs off that node, even when another path also leads into it, which is what
 * keeps a true target above the false target it later merges with. Failing
 * that, a node hangs off the parent furthest to the right. The remaining edges
 * are drawn but do not decide where anything sits.
 */
function spanningTree(
  realNodes: Node[],
  roots: string[],
  graph: Graph,
  columns: Map<string, number>
): { roots: string[]; children: Map<string, string[]> } {
  const treeParent = new Map<string, string>();
  const attached = new Set(roots);

  const byColumn: string[][] = [];
  for (const node of realNodes) {
    const col = columns.get(node.id) ?? 0;
    byColumn[col] = byColumn[col] ?? [];
    byColumn[col].push(node.id);
  }

  const treeRoots = [...roots];

  for (const [col, ids] of byColumn.entries()) {
    for (const id of ids ?? []) {
      if (attached.has(id)) {
        continue;
      }
      let from: string | undefined;
      let fromColumn = Number.NEGATIVE_INFINITY;
      let fromBranch = false;
      for (const parent of graph.parents.get(id) ?? []) {
        const parentColumn = columns.get(parent) ?? 0;
        if (!attached.has(parent) || parentColumn >= col) {
          continue;
        }
        const isBranch = graph.branchEdges.has(`${parent}->${id}`);
        const better =
          isBranch === fromBranch ? parentColumn > fromColumn : isBranch;
        if (better) {
          from = parent;
          fromColumn = parentColumn;
          fromBranch = isBranch;
        }
      }
      attached.add(id);
      if (from === undefined) {
        treeRoots.push(id);
      } else {
        treeParent.set(id, from);
      }
    }
  }

  // Children keep the order their edges leave the node: upper handle first.
  const children = new Map<string, string[]>();
  for (const node of realNodes) {
    const kept = (graph.children.get(node.id) ?? []).filter(
      (child) => treeParent.get(child) === node.id
    );
    children.set(node.id, kept);
  }

  return { roots: treeRoots, children };
}

/**
 * Give every subtree its own band of rows. A node with no branches of its own
 * takes one row; a node that branches spans the bands of its branches and sits
 * in the middle of them. Bands never overlap, so two branches never interleave
 * and their edges have no reason to cross.
 */
function assignRows(
  treeRoots: string[],
  children: Map<string, string[]>
): Map<string, number> {
  const rows = new Map<string, number>();
  let nextRow = 0;

  const place = (id: string): { first: number; last: number } => {
    const kids = children.get(id) ?? [];
    if (kids.length === 0) {
      const row = nextRow++;
      rows.set(id, row * ROW_STEP);
      return { first: row, last: row };
    }

    let first = Number.POSITIVE_INFINITY;
    let last = Number.NEGATIVE_INFINITY;
    for (const kid of kids) {
      const band = place(kid);
      first = Math.min(first, band.first);
      last = Math.max(last, band.last);
    }
    rows.set(id, ((first + last) / 2) * ROW_STEP);
    return { first, last };
  };

  for (const root of treeRoots) {
    place(root);
  }

  return rows;
}

/**
 * Compute a clean left-to-right DAG layout for workflow nodes.
 *
 * - Columns via longest-path topological sort (handles convergence)
 * - Rows via tidy bands: each branch owns a range of rows nothing else uses
 * - Branches follow their handles: true/done above, false/loop below
 * - Loop bodies lay out to the right of their For Each node; only the edges
 *   that close a cycle are ignored
 */
export function computeAutoLayout(
  nodes: Node[],
  edges: Edge[]
): Map<string, { x: number; y: number }> {
  const realNodes = nodes.filter((n) => n.type !== "add");
  const forwardEdges = forwardEdgesOf(realNodes, edges);
  const graph = buildGraph(realNodes, forwardEdges);
  const roots = findRoots(realNodes, graph.inDegree);
  const columns = assignColumns(roots, graph);
  const tree = spanningTree(realNodes, roots, graph, columns);
  const rows = assignRows(tree.roots, tree.children);

  let topRow = Number.POSITIVE_INFINITY;
  for (const row of rows.values()) {
    topRow = Math.min(topRow, row);
  }
  const offset = Number.isFinite(topRow) ? topRow : 0;

  const positions = new Map<string, { x: number; y: number }>();
  for (const node of realNodes) {
    positions.set(node.id, {
      x: (columns.get(node.id) ?? 0) * COLUMN_STEP,
      y: Math.round((rows.get(node.id) ?? 0) - offset),
    });
  }

  return positions;
}
