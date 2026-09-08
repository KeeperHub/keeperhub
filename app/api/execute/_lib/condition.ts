export const VALID_OPERATORS = ["eq", "gt", "lt", "gte", "lte", "neq"] as const;

export type ConditionOperator = (typeof VALID_OPERATORS)[number];

export type ConditionInput = {
  operator: ConditionOperator;
  value: string;
};

export type ConditionResult = {
  met: boolean;
  observedValue: string;
  targetValue: string;
  operator: ConditionOperator;
};

export function isValidOperator(op: unknown): op is ConditionOperator {
  return (
    typeof op === "string" && VALID_OPERATORS.includes(op as ConditionOperator)
  );
}

function compareBigInt(a: bigint, b: bigint, op: ConditionOperator): boolean {
  switch (op) {
    case "eq":
      return a === b;
    case "neq":
      return a !== b;
    case "gt":
      return a > b;
    case "lt":
      return a < b;
    case "gte":
      return a >= b;
    case "lte":
      return a <= b;
    default:
      return false;
  }
}

function extractObservedString(observed: unknown): string | null {
  let scalar = observed;
  if (
    observed !== null &&
    typeof observed === "object" &&
    !Array.isArray(observed)
  ) {
    const keys = Object.keys(observed as Record<string, unknown>);
    if (keys.length === 1) {
      scalar = (observed as Record<string, unknown>)[keys[0]];
    }
  }

  if (typeof scalar === "string" && scalar.trim() !== "") {
    return scalar;
  }
  if (typeof scalar === "bigint") {
    return scalar.toString();
  }
  return null;
}

export function evaluateCondition(
  observed: unknown,
  condition: ConditionInput
): ConditionResult | null {
  const observedStr = extractObservedString(observed);
  const { operator, value: targetValue } = condition;

  if (observedStr === null) {
    return null;
  }

  try {
    const observedBig = BigInt(observedStr);
    const targetBig = BigInt(targetValue);
    return {
      met: compareBigInt(observedBig, targetBig, operator),
      observedValue: observedStr,
      targetValue,
      operator,
    };
  } catch {
    return null;
  }
}
