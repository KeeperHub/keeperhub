import { findStoredRef, splitTemplateRef } from "@/lib/workflow/template-ref";
import { findActionById } from "@/plugins/registry";
import { BUILTIN_NODE_ID } from "./builtin-variables";

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
  const ref = findStoredRef(template);
  if (!ref) {
    return false;
  }

  const { nodeId } = ref;
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
  const ref = findStoredRef(template);
  if (!ref) {
    return template;
  }

  const { nodeId, rest } = ref;

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

  const { fieldPath } = splitTemplateRef(rest, displayLabel);

  if (!fieldPath) {
    return displayLabel ?? rest;
  }

  if (!displayLabel) {
    return rest;
  }

  return `${displayLabel}.${fieldPath}`;
}
