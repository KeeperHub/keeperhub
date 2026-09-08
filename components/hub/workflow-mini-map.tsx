import type { WorkflowEdge, WorkflowNode } from "@/lib/workflow/store";

type WorkflowMiniMapProps = {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  width?: number;
  height?: number;
  className?: string;
};

type Bounds = {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  width: number;
  height: number;
};

const DEFAULT_NODE_SIZE = 18;
const MIN_NODE_SIZE = 10;
const NODE_GAP = 4;
const PADDING = 20;

function computeNodeSize(
  nodeCount: number,
  bounds: Bounds,
  width: number,
  height: number
): number {
  if (nodeCount <= 4) {
    return DEFAULT_NODE_SIZE;
  }

  // Find minimum distance between any two nodes to avoid overlap
  const availW = width - PADDING * 2;
  const availH = height - PADDING * 2;
  const scaleX = bounds.width > 0 ? availW / bounds.width : 1;
  const scaleY = bounds.height > 0 ? availH / bounds.height : 1;
  const scale = Math.min(scaleX, scaleY);

  // Max node size that fits without overlapping nearest neighbors
  // Use bounds span / node count as a rough density measure
  const avgSpacingX =
    bounds.width > 0 ? (bounds.width * scale) / Math.sqrt(nodeCount) : availW;
  const avgSpacingY =
    bounds.height > 0 ? (bounds.height * scale) / Math.sqrt(nodeCount) : availH;
  const avgSpacing = Math.min(avgSpacingX, avgSpacingY);
  const maxSize = Math.max(MIN_NODE_SIZE, avgSpacing - NODE_GAP);

  return Math.min(DEFAULT_NODE_SIZE, Math.floor(maxSize));
}

function calculateBounds(nodes: WorkflowNode[]): Bounds {
  if (nodes.length === 0) {
    return { minX: 0, minY: 0, maxX: 100, maxY: 100, width: 100, height: 100 };
  }

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const node of nodes) {
    const x = node.position?.x ?? 0;
    const y = node.position?.y ?? 0;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }

  return {
    minX,
    minY,
    maxX,
    maxY,
    width: maxX - minX,
    height: maxY - minY,
  };
}

function MiniNode({
  node,
  bounds,
  posScale,
  offsetX,
  offsetY,
  nodeSize,
}: {
  node: WorkflowNode;
  bounds: Bounds;
  posScale: number;
  offsetX: number;
  offsetY: number;
  nodeSize: number;
}) {
  const x = ((node.position?.x ?? 0) - bounds.minX) * posScale + offsetX;
  const y = ((node.position?.y ?? 0) - bounds.minY) * posScale + offsetY;
  const isTrigger = node.type === "trigger" || node.data?.type === "trigger";

  return (
    <rect
      className={
        isTrigger
          ? "fill-[var(--color-text-accent)]/60"
          : "fill-[var(--color-hub-node-bg)]"
      }
      height={nodeSize}
      rx={nodeSize * 0.15}
      ry={nodeSize * 0.15}
      width={nodeSize}
      x={x}
      y={y}
    />
  );
}

function MiniEdge({
  edge,
  nodes,
  bounds,
  posScale,
  offsetX,
  offsetY,
  nodeSize,
}: {
  edge: WorkflowEdge;
  nodes: WorkflowNode[];
  bounds: Bounds;
  posScale: number;
  offsetX: number;
  offsetY: number;
  nodeSize: number;
}) {
  const sourceNode = nodes.find((n) => n.id === edge.source);
  const targetNode = nodes.find((n) => n.id === edge.target);

  if (!(sourceNode && targetNode)) {
    return null;
  }

  const sourceX =
    ((sourceNode.position?.x ?? 0) - bounds.minX) * posScale +
    offsetX +
    nodeSize;
  const sourceY =
    ((sourceNode.position?.y ?? 0) - bounds.minY) * posScale +
    offsetY +
    nodeSize / 2;

  const targetX =
    ((targetNode.position?.x ?? 0) - bounds.minX) * posScale + offsetX;
  const targetY =
    ((targetNode.position?.y ?? 0) - bounds.minY) * posScale +
    offsetY +
    nodeSize / 2;

  const midX = (sourceX + targetX) / 2;

  return (
    <path
      className="fill-none stroke-muted-foreground/60"
      d={`M ${sourceX} ${sourceY} C ${midX} ${sourceY}, ${midX} ${targetY}, ${targetX} ${targetY}`}
      strokeWidth={1.2}
    />
  );
}

export function WorkflowMiniMap({
  nodes,
  edges,
  width = 280,
  height = 160,
  className = "",
}: WorkflowMiniMapProps) {
  if (!nodes || nodes.length === 0) {
    return (
      <svg
        aria-label="Empty workflow diagram"
        className={`${className}`}
        height="100%"
        preserveAspectRatio="xMidYMid meet"
        role="img"
        viewBox={`0 0 ${width} ${height}`}
        width="100%"
      >
        <rect
          className="fill-slate-300"
          height={DEFAULT_NODE_SIZE}
          rx={6}
          width={DEFAULT_NODE_SIZE * 2}
          x={width / 2 - DEFAULT_NODE_SIZE}
          y={height / 2 - DEFAULT_NODE_SIZE / 2}
        />
      </svg>
    );
  }

  const bounds = calculateBounds(nodes);
  const nodeSize = computeNodeSize(nodes.length, bounds, width, height);

  const availW = width - PADDING * 2 - nodeSize;
  const availH = height - PADDING * 2 - nodeSize;
  const posScaleX = bounds.width > 0 ? availW / bounds.width : 1;
  const posScaleY = bounds.height > 0 ? availH / bounds.height : 1;
  const posScale = Math.min(posScaleX, posScaleY);

  const scaledContentW = bounds.width * posScale + nodeSize;
  const scaledContentH = bounds.height * posScale + nodeSize;
  const offsetX = (width - scaledContentW) / 2;
  const offsetY = (height - scaledContentH) / 2;

  return (
    <svg
      aria-label="Workflow diagram"
      className={`${className}`}
      height="100%"
      preserveAspectRatio="xMidYMid meet"
      role="img"
      viewBox={`0 0 ${width} ${height}`}
      width="100%"
    >
      {edges.map((edge) => (
        <MiniEdge
          bounds={bounds}
          edge={edge}
          key={edge.id}
          nodeSize={nodeSize}
          nodes={nodes}
          offsetX={offsetX}
          offsetY={offsetY}
          posScale={posScale}
        />
      ))}
      {nodes
        .filter((node) => node.type !== "add")
        .map((node) => (
          <MiniNode
            bounds={bounds}
            key={node.id}
            node={node}
            nodeSize={nodeSize}
            offsetX={offsetX}
            offsetY={offsetY}
            posScale={posScale}
          />
        ))}
    </svg>
  );
}
