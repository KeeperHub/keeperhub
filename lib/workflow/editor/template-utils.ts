import { findActionById } from "@/plugins/registry";
import { BUILTIN_NODE_ID } from "./builtin-variables";

const TEMPLATE_REF_PATTERN = /\{\{@([^:]+):([^}]+)\}\}/;

/** Minimal node shape needed by template helpers */
export type TemplateNode = {
  id: string;
  data: {
    label?: string;
    type?: string;
    config?: Record<string, unknown>;
  };
};

/**
 * Checks whether a template reference like {{@nodeId:Label.field}}
 * points to a node that exists in the workflow (or is the built-in
 * __system pseudo-node).
 */
export function doesNodeExist(
  template: string,
  nodes: ReadonlyArray<{ id: string }>
): boolean {
  const match = template.match(TEMPLATE_REF_PATTERN);
  if (!match) {
    return false;
  }

  const nodeId = match[1];
  if (nodeId === BUILTIN_NODE_ID) {
    return true;
  }
  return nodes.some((n) => n.id === nodeId);
}

/**
 * Gets display text for a template badge by looking up the current node label.
 * Resolves {{@nodeId:OldLabel.field}} to "CurrentLabel.field".
 */
export function getDisplayTextForTemplate(
  template: string,
  nodes: readonly TemplateNode[]
): string {
  const match = template.match(TEMPLATE_REF_PATTERN);
  if (!match) {
    return template;
  }

  const nodeId = match[1];
  const rest = match[2];

  const node = nodes.find((n) => n.id === nodeId);
  if (!node) {
    return rest;
  }

  let displayLabel: string | undefined = node.data.label;
  if (!displayLabel && node.data.type === "action") {
    const actionType = node.data.config?.actionType as string | undefined;
    if (actionType) {
      const action = findActionById(actionType);
      displayLabel = action?.label;
    }
  }

  const dotIndex = rest.indexOf(".");

  if (dotIndex === -1) {
    return displayLabel ?? rest;
  }

  const field = rest.substring(dotIndex + 1);

  if (!displayLabel) {
    return rest;
  }

  return `${displayLabel}.${field}`;
}
