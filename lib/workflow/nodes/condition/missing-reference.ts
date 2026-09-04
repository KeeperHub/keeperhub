/**
 * Marker bound in place of a condition reference whose field path is not
 * present on the referenced node's output.
 *
 * Every reference in a condition is resolved before the expression is
 * evaluated, so the resolver cannot know which operator a given operand
 * belongs to. Binding this marker defers that decision to evaluation: the
 * presence operators (is undefined, is not undefined, exists, does not exist,
 * is empty, is not empty) read it as `undefined` and evaluate normally, while
 * any other operator rejects it and the run fails with the resolver's original
 * diagnostic.
 *
 * That keeps a deliberate existence check working without letting a mistyped
 * path quietly satisfy a comparison and route the workflow down a branch the
 * author did not intend.
 */

export type MissingReference = {
  readonly __keeperhubMissingReference: true;
  /** Resolver diagnostic, including the available field names. */
  readonly detail: string;
};

export function makeMissingReference(detail: string): MissingReference {
  return { __keeperhubMissingReference: true, detail };
}

export function isMissingReference(value: unknown): value is MissingReference {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as MissingReference).__keeperhubMissingReference === true
  );
}

/** Literals a presence check compares against; the marker reads as undefined. */
export function isPresenceProbe(other: unknown): boolean {
  return other === undefined || other === null || other === "";
}

const EQUALITY_OPERATORS = new Set(["===", "!==", "==", "!="]);

export function isEqualityOperator(operator: string): boolean {
  return EQUALITY_OPERATORS.has(operator);
}

export function missingReferenceError(reference: MissingReference): Error {
  return new Error(
    `Condition references field ${reference.detail} Use the "is undefined" or "is not undefined" operator to test whether the field is present.`
  );
}
