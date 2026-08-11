/**
 * Workflow Progress Tracking Utilities
 *
 * Provides functions for calculating step counts and tracking execution progress.
 */

import type { Edge, Node } from "@xyflow/react";

type WorkflowNodeData = {
  type: "trigger" | "action" | "add";
  enabled?: boolean;
};

type WorkflowNode = Node<WorkflowNodeData>;
type WorkflowEdge = Edge;

/**
 * Calculate total executable steps by traversing the workflow graph from trigger nodes.
 * Only counts reachable, enabled nodes (excludes disabled nodes and "add" type nodes).
 */
export function calculateTotalSteps(
  nodes: WorkflowNode[],
  edges: WorkflowEdge[]
): number {
  // Build adjacency list (source -> targets)
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    const targets = adjacency.get(edge.source) || [];
    targets.push(edge.target);
    adjacency.set(edge.source, targets);
  }

  // Find trigger nodes (type === "trigger" and enabled)
  const triggerNodes = nodes.filter(
    (n) => n.data?.type === "trigger" && n.data?.enabled !== false
  );

  // BFS from triggers to count reachable, enabled nodes
  const visited = new Set<string>();
  const queue = [...triggerNodes.map((n) => n.id)];

  while (queue.length > 0) {
    const nodeId = queue.shift();
    if (nodeId === undefined || visited.has(nodeId)) {
      continue;
    }

    const node = nodes.find((n) => n.id === nodeId);
    if (!node) {
      continue;
    }

    // Skip disabled nodes and "add" type nodes
    if (node.data?.enabled === false || node.data?.type === "add") {
      continue;
    }

    visited.add(nodeId);

    // Add children to queue
    const children = adjacency.get(nodeId) || [];
    queue.push(...children);
  }

  return visited.size;
}

/**
 * Get the list of executable node IDs in BFS order from triggers.
 * Useful for understanding execution order.
 */
export function getExecutableNodeIds(
  nodes: WorkflowNode[],
  edges: WorkflowEdge[]
): string[] {
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    const targets = adjacency.get(edge.source) || [];
    targets.push(edge.target);
    adjacency.set(edge.source, targets);
  }

  const triggerNodes = nodes.filter(
    (n) => n.data?.type === "trigger" && n.data?.enabled !== false
  );

  const visited = new Set<string>();
  const result: string[] = [];
  const queue = [...triggerNodes.map((n) => n.id)];

  while (queue.length > 0) {
    const nodeId = queue.shift();
    if (nodeId === undefined || visited.has(nodeId)) {
      continue;
    }

    const node = nodes.find((n) => n.id === nodeId);
    if (!node) {
      continue;
    }

    if (node.data?.enabled === false || node.data?.type === "add") {
      continue;
    }

    visited.add(nodeId);
    result.push(nodeId);

    const children = adjacency.get(nodeId) || [];
    queue.push(...children);
  }

  return result;
}
