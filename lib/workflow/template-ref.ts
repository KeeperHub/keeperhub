/**
 * Splitting for the `Label.field` half of a `{{@nodeId:Label.field}}` reference.
 */

export type TemplateRefParts = {
  label: string;
  fieldPath: string;
};

/**
 * Split `Label.field` into its label and field path.
 *
 * The label is baked into the token at authoring time and may itself contain
 * dots (a node named "check app.keeperhub.com"), so splitting on the first dot
 * reads part of the label as the field path. Prefer the node's known label and
 * fall back to the first dot when it is absent or stale, which is what a
 * reference stored before the node was renamed carries.
 */
export function splitTemplateRef(
  rest: string,
  nodeLabel?: string
): TemplateRefParts {
  if (nodeLabel) {
    if (rest === nodeLabel) {
      return { label: nodeLabel, fieldPath: "" };
    }
    if (rest.startsWith(`${nodeLabel}.`)) {
      return { label: nodeLabel, fieldPath: rest.slice(nodeLabel.length + 1) };
    }
  }

  const dotIndex = rest.indexOf(".");
  if (dotIndex === -1) {
    return { label: rest, fieldPath: "" };
  }
  return {
    label: rest.slice(0, dotIndex),
    fieldPath: rest.slice(dotIndex + 1),
  };
}
