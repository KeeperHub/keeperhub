import { ADDRESS_BOOK_SELECTION_KEY } from "@/lib/address-book-selection";
import { evaluateShowWhen } from "@/lib/workflow/editor/show-when";
import {
  type ActionConfigField,
  type ActionConfigFieldBase,
  findActionById,
} from "@/plugins/registry";

const SYSTEM_ACTION_TYPES = new Set([
  "Database Query",
  "HTTP Request",
  "Condition",
  "For Each",
  "Collect",
]);

const RESERVED_CONFIG_KEYS = new Set([
  "actionType",
  "integrationId",
  ADDRESS_BOOK_SELECTION_KEY,
  "usePrivateMempool",
  "strict",
  // UI-only state written by the abi-with-auto-fetch field renderer
  // (components/workflow/config/abi-with-auto-fetch-field.tsx). Persisted on
  // every action that uses that field type so the form remembers the user's
  // manual-vs-fetched ABI toggle across reloads. The step runtime never reads
  // it.
  "useManualAbi",
]);

const TEMPLATE_VALUE_PATTERN = /\{\{[^}]+}}/;
const ETH_ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const HEX_BYTES_PATTERN = /^0x(?:[0-9a-fA-F]{2})*$/;
const INTEGER_PATTERN = /^-?\d+$/;
const UNSIGNED_INTEGER_PATTERN = /^\d+$/;
const DECIMAL_PATTERN = /^\d+(?:\.\d+)?$/;

export type ActionConfigValidationIssueCode =
  | "UNKNOWN_ACTION_TYPE"
  | "UNKNOWN_FIELD"
  | "MISSING_REQUIRED_FIELD"
  | "INVALID_FIELD_TYPE";

export type ActionConfigValidationIssue = {
  code: ActionConfigValidationIssueCode;
  path: string;
  message: string;
  actionType?: string;
  field?: string;
  expected?: string;
  received?: unknown;
};

export type ActionConfigValidationResult = {
  valid: boolean;
  issues: ActionConfigValidationIssue[];
};

export type WorkflowNodeForValidation = {
  id?: string;
  type?: unknown;
  data?: {
    type?: unknown;
    config?: Record<string, unknown>;
  };
};

type FieldCheckResult =
  | { valid: true }
  | { valid: false; expected: string; received: unknown };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isActionNode(node: WorkflowNodeForValidation): boolean {
  return node.type === "action" || node.data?.type === "action";
}

function isMissingRequiredValue(value: unknown): boolean {
  return value === undefined || value === null || value === "";
}

function flattenConfigFields(
  fields: ActionConfigField[]
): ActionConfigFieldBase[] {
  const flattened: ActionConfigFieldBase[] = [];

  for (const field of fields) {
    if (field.type === "group") {
      flattened.push(...flattenConfigFields(field.fields));
      continue;
    }
    flattened.push(field);
  }

  return flattened;
}

function valueContainsTemplate(value: unknown): boolean {
  return typeof value === "string" && TEMPLATE_VALUE_PATTERN.test(value);
}

function isJsonArrayString(value: unknown): boolean {
  if (typeof value !== "string") {
    return false;
  }
  try {
    return Array.isArray(JSON.parse(value));
  } catch {
    return false;
  }
}

function isJsonArrayOrObjectString(value: unknown): boolean {
  if (typeof value !== "string") {
    return false;
  }
  const trimmed = value.trim();
  if (trimmed === "") {
    return true;
  }
  try {
    const parsed = JSON.parse(trimmed);
    return (
      Array.isArray(parsed) || (typeof parsed === "object" && parsed !== null)
    );
  } catch {
    return false;
  }
}

// Legacy field keys that older workflows persisted before a field rename.
// They are accepted on save (treated as the canonical key for validation) so
// users can re-save existing workflows that contain the legacy shape. The
// runtime is responsible for normalizing aliases when it reads the config.
const LEGACY_FIELD_ALIASES: Record<string, Record<string, string>> = {
  "web3/read-contract": { functionName: "abiFunction", args: "functionArgs" },
  "web3/write-contract": { functionName: "abiFunction", args: "functionArgs" },
};

// Legacy config keys that don't map to a canonical field but should not be
// rejected on save. Typically these are leftovers from a sibling action's
// form state (e.g. an editor session that started as batch-read-contract and
// was switched to query-transactions persisted batch-read's `inputMode` /
// `batchSize`) or fields that were removed during a refactor. The runtime
// ignores them; the validator must too, otherwise legacy / cross-org imports
// can't be saved.
const LEGACY_IGNORED_FIELDS: Record<string, Set<string>> = {
  "web3/query-transactions": new Set(["inputMode", "batchSize"]),
  "web3/query-events": new Set(["inputMode", "batchSize"]),
  // The editor persists the resolved function signature (for overloaded-
  // function disambiguation); the runtime recomputes it and never reads it
  // from config, so it must not block a save.
  "web3/read-contract": new Set(["abiFunctionKey"]),
  "web3/write-contract": new Set(["abiFunctionKey"]),
};

function getLegacyAliasMap(actionType: string): Record<string, string> {
  return LEGACY_FIELD_ALIASES[actionType] ?? {};
}

function isLegacyIgnoredField(actionType: string, key: string): boolean {
  return LEGACY_IGNORED_FIELDS[actionType]?.has(key) ?? false;
}

// UI-only companion metadata carries one of these prefixes (a datetime field's
// display timezone `_tz_<key>`, event/protocol picker state). The step runtime
// never reads them, so they are tolerated by config validation. An `_`-prefixed
// key outside this set still surfaces as UNKNOWN_FIELD so a typo does not pass
// silently.
const METADATA_KEY_PREFIXES = ["_tz_", "_event", "_protocol"] as const;

function isMetadataKey(key: string): boolean {
  return METADATA_KEY_PREFIXES.some((prefix) => key.startsWith(prefix));
}

// Whether a config key is accepted for the given action. Mirrors the
// UNKNOWN_FIELD check in validateWorkflowActionConfigs so the editor can prune
// cross-action leftovers before save with the same allowlist the server uses.
// Unknown action types return true; that case is reported separately.
export function isKnownConfigKeyForAction(
  actionType: string,
  key: string
): boolean {
  if (RESERVED_CONFIG_KEYS.has(key)) {
    return true;
  }
  const action = findActionById(actionType);
  if (!action) {
    return true;
  }
  const fieldKeys = new Set(
    flattenConfigFields(action.configFields).map((field) => field.key)
  );
  if (fieldKeys.has(key)) {
    return true;
  }
  const aliasMap = getLegacyAliasMap(actionType);
  if (aliasMap[key] && fieldKeys.has(aliasMap[key])) {
    return true;
  }
  return isLegacyIgnoredField(actionType, key);
}

function validateStringLike(value: unknown): boolean {
  return typeof value === "string" || typeof value === "number";
}

function validateFieldValue(
  field: ActionConfigFieldBase,
  value: unknown
): FieldCheckResult {
  if (isMissingRequiredValue(value)) {
    return { valid: true };
  }

  switch (field.type) {
    case "number":
      return typeof value === "number" || DECIMAL_PATTERN.test(String(value))
        ? { valid: true }
        : { valid: false, expected: "number", received: value };
    case "select":
      if (!validateStringLike(value)) {
        return { valid: false, expected: "select option", received: value };
      }
      if (
        field.options &&
        field.options.length > 0 &&
        !field.options.some((option) => option.value === String(value))
      ) {
        return {
          valid: false,
          expected: field.options.map((option) => option.value).join(" | "),
          received: value,
        };
      }
      return { valid: true };
    case "chain-select":
      if (!validateStringLike(value)) {
        return { valid: false, expected: "chain id", received: value };
      }
      if (
        field.allowedChainIds &&
        field.allowedChainIds.length > 0 &&
        !field.allowedChainIds.includes(String(value))
      ) {
        return {
          valid: false,
          expected: field.allowedChainIds.join(" | "),
          received: value,
        };
      }
      return { valid: true };
    case "protocol-address":
      return typeof value === "string" &&
        (valueContainsTemplate(value) || ETH_ADDRESS_PATTERN.test(value))
        ? { valid: true }
        : { valid: false, expected: "address", received: value };
    case "protocol-uint":
      return typeof value === "string" &&
        (valueContainsTemplate(value) || UNSIGNED_INTEGER_PATTERN.test(value))
        ? { valid: true }
        : {
            valid: false,
            expected: field.solidityType ?? "uint",
            received: value,
          };
    case "protocol-int":
      return typeof value === "string" &&
        (valueContainsTemplate(value) || INTEGER_PATTERN.test(value))
        ? { valid: true }
        : {
            valid: false,
            expected: field.solidityType ?? "int",
            received: value,
          };
    case "protocol-bool":
      if (valueContainsTemplate(value)) {
        return { valid: true };
      }
      return value === true ||
        value === false ||
        value === "true" ||
        value === "false"
        ? { valid: true }
        : { valid: false, expected: "boolean", received: value };
    case "protocol-bytes":
      return typeof value === "string" &&
        (valueContainsTemplate(value) || HEX_BYTES_PATTERN.test(value))
        ? { valid: true }
        : {
            valid: false,
            expected: field.solidityType ?? "bytes",
            received: value,
          };
    case "protocol-eth-value":
      return typeof value === "string" &&
        (valueContainsTemplate(value) || DECIMAL_PATTERN.test(value))
        ? { valid: true }
        : { valid: false, expected: "decimal ETH amount", received: value };
    case "protocol-tuple-array":
      return Array.isArray(value) ||
        valueContainsTemplate(value) ||
        isJsonArrayString(value)
        ? { valid: true }
        : {
            valid: false,
            expected: field.solidityType ?? "tuple[]",
            received: value,
          };
    case "json-editor":
    case "schema-builder":
    case "abi-function-args":
    case "call-list-builder":
    case "args-list-builder":
      return isRecord(value) ||
        Array.isArray(value) ||
        valueContainsTemplate(value) ||
        isJsonArrayOrObjectString(value)
        ? { valid: true }
        : { valid: false, expected: "object or array", received: value };
    default:
      if (field.isAddressField) {
        return typeof value === "string" &&
          (valueContainsTemplate(value) || ETH_ADDRESS_PATTERN.test(value))
          ? { valid: true }
          : { valid: false, expected: "address", received: value };
      }
      return validateStringLike(value) || typeof value === "boolean"
        ? { valid: true }
        : { valid: false, expected: "string", received: value };
  }
}

export function validateWorkflowActionConfigs(
  nodes: WorkflowNodeForValidation[]
): ActionConfigValidationResult {
  const issues: ActionConfigValidationIssue[] = [];

  for (const [nodeIndex, node] of nodes.entries()) {
    if (!isActionNode(node)) {
      continue;
    }

    const config = node.data?.config;
    if (!isRecord(config)) {
      continue;
    }

    const actionType = config.actionType;
    if (typeof actionType !== "string" || actionType.trim() === "") {
      continue;
    }

    if (SYSTEM_ACTION_TYPES.has(actionType)) {
      continue;
    }

    const action = findActionById(actionType);
    if (!action) {
      issues.push({
        code: "UNKNOWN_ACTION_TYPE",
        path: `nodes[${nodeIndex}].data.config.actionType`,
        actionType,
        received: actionType,
        message: `Unknown action type "${actionType}".`,
      });
      continue;
    }

    // Draft state: the config contains only actionType, reserved keys, and
    // known metadata keys — no user-supplied parameters yet. Skip all validation
    // for this node: required-field, type, and UNKNOWN_FIELD checks are omitted
    // because companion metadata (e.g. `_tz_<key>`) would otherwise be flagged.
    const hasUserParams = Object.keys(config).some(
      (k) => !(RESERVED_CONFIG_KEYS.has(k) || isMetadataKey(k))
    );
    if (!hasUserParams) {
      continue;
    }

    const fields = flattenConfigFields(action.configFields);
    const fieldsByKey = new Map(fields.map((field) => [field.key, field]));
    const aliasMap = getLegacyAliasMap(actionType);

    for (const [key, value] of Object.entries(config)) {
      if (RESERVED_CONFIG_KEYS.has(key)) {
        continue;
      }
      // Known companion metadata (e.g. a datetime field's display timezone
      // `_tz_<key>`) is UI-only; the step runtime never reads it, so it is never
      // an "unknown field". Other `_`-prefixed keys still fall through and report.
      if (isMetadataKey(key)) {
        continue;
      }
      if (fieldsByKey.has(key)) {
        continue;
      }
      if (aliasMap[key] && fieldsByKey.has(aliasMap[key])) {
        continue;
      }
      if (isLegacyIgnoredField(actionType, key)) {
        continue;
      }
      issues.push({
        code: "UNKNOWN_FIELD",
        path: `nodes[${nodeIndex}].data.config.${key}`,
        actionType,
        field: key,
        received: value,
        message: `Unknown field "${key}" for action "${actionType}".`,
      });
    }

    for (const field of fields) {
      if (!evaluateShowWhen(field.showWhen, config)) {
        continue;
      }

      const legacyKey = Object.entries(aliasMap).find(
        ([, canonical]) => canonical === field.key
      )?.[0];
      const canonicalValue = config[field.key];
      const value =
        canonicalValue !== undefined ||
        legacyKey === undefined ||
        config[legacyKey] === undefined
          ? canonicalValue
          : config[legacyKey];

      if (field.required && isMissingRequiredValue(value)) {
        issues.push({
          code: "MISSING_REQUIRED_FIELD",
          path: `nodes[${nodeIndex}].data.config.${field.key}`,
          actionType,
          field: field.key,
          expected: field.label,
          message: `Missing required field "${field.key}" for action "${actionType}".`,
        });
        continue;
      }

      const fieldCheck = validateFieldValue(field, value);
      if (!fieldCheck.valid) {
        issues.push({
          code: "INVALID_FIELD_TYPE",
          path: `nodes[${nodeIndex}].data.config.${field.key}`,
          actionType,
          field: field.key,
          expected: fieldCheck.expected,
          received: fieldCheck.received,
          message: `Invalid value for field "${field.key}" on action "${actionType}".`,
        });
      }
    }
  }

  return { valid: issues.length === 0, issues };
}

// Returns true if any known action node in `nodes` is in draft state — i.e.
// its config contains only actionType, reserved keys, and underscore-prefixed
// metadata keys with no user-supplied parameters. Used by the PATCH handler to
// block enabling a workflow before all action nodes are configured.
export function hasDraftActionNodes(
  nodes: WorkflowNodeForValidation[]
): boolean {
  for (const node of nodes) {
    if (!isActionNode(node)) {
      continue;
    }
    const config = node.data?.config;
    if (!isRecord(config)) {
      continue;
    }
    const actionType = config.actionType;
    if (typeof actionType !== "string" || actionType.trim() === "") {
      continue;
    }
    if (SYSTEM_ACTION_TYPES.has(actionType)) {
      continue;
    }
    if (!findActionById(actionType)) {
      continue;
    }
    const hasUserParams = Object.keys(config).some(
      (k) => !(RESERVED_CONFIG_KEYS.has(k) || isMetadataKey(k))
    );
    if (!hasUserParams) {
      return true;
    }
  }
  return false;
}

export function formatActionConfigValidationResponse(
  validation: ActionConfigValidationResult
) {
  return {
    error: "INVALID_ACTION_CONFIG",
    message:
      "Workflow contains invalid action configuration. Fix the listed fields and save again.",
    invalidFields: validation.issues,
  };
}
