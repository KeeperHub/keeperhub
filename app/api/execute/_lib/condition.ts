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

function extractObservedString(observed: unknown): string {
  if (
    observed !== null &&
    typeof observed === "object" &&
    !Array.isArray(observed)
  ) {
    const keys = Object.keys(observed as Record<string, unknown>);
    if (keys.length === 1) {
      return String((observed as Record<string, unknown>)[keys[0]]);
    }
  }
  return String(observed);
}

export function evaluateCondition(
  observed: unknown,
  condition: ConditionInput
): ConditionResult {
  const observedStr = extractObservedString(observed);
  const { operator, value: targetValue } = condition;

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
    // BigInt parsing failed -- fall back to string eq/neq
  }

  let met = false;
  if (operator === "eq") {
    met = observedStr === targetValue;
  } else if (operator === "neq") {
    met = observedStr !== targetValue;
  }

  return {
    met,
    observedValue: observedStr,
    targetValue,
    operator,
  };
}
