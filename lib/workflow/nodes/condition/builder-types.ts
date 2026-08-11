export type ConditionOperator =
  | "=="
  | "==="
  | "!="
  | "!=="
  | ">"
  | ">="
  | "<"
  | "<="
  | "contains"
  | "startsWith"
  | "endsWith"
  | "isEmpty"
  | "isNotEmpty"
  | "exists"
  | "doesNotExist"
  | "isNull"
  | "isNotNull"
  | "isUndefined"
  | "isNotUndefined"
  | "matchesRegex"
  | "isTrue"
  | "isFalse"
  | "arrayIsEmpty"
  | "arrayIsNotEmpty"
  | "arrayContains"
  | "arrayLength"
  | "objectIsEmpty"
  | "objectHasKey";

export type ConditionRule = {
  id: string;
  leftOperand: string;
  operator: ConditionOperator;
  rightOperand: string;
};

export type ConditionGroup = {
  id: string;
  logic: "AND" | "OR";
  rules: Array<ConditionRule | ConditionGroup>;
};

export type ConditionConfig = {
  group: ConditionGroup;
};

export function isConditionGroup(
  item: ConditionRule | ConditionGroup
): item is ConditionGroup {
  return "logic" in item && "rules" in item;
}
