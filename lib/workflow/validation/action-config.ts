import { ADDRESS_BOOK_SELECTION_KEY } from "@/lib/address-book-selection";
import { evaluateShowWhen } from "@/lib/workflow/editor/show-when";
import { SYSTEM_ACTION_TYPES as SYSTEM_ACTION_TYPE_LIST } from "@/lib/workflow/executor/system-action-types";
import {
  type ActionConfigField,
  type ActionConfigFieldBase,
  findActionById,
  getAllActions,
} from "@/plugins/registry";

// Built from the shared union so this validator, the executor dispatch table,
// and the egress map cannot drift apart when a system action is added.
const SYSTEM_ACTION_TYPES = new Set<string>(SYSTEM_ACTION_TYPE_LIST);

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

// Maximum characters for a node label rendered into the top-level message.
// Matches the 500-char cap in export-schema.ts but shorter for readability.
const NODE_LABEL_MAX_CHARS = 100;

// Control characters, Unicode bidi overrides and isolates that can inject
// invisible text or alter rendering order in error messages. Stripped from
// node labels before interpolation into the summary.
//
// Covers: C0 + DEL + C1 controls, line/paragraph separators, zero-width
// chars (ZWSP/ZWNJ/ZWJ/LRM/RLM), bidi overrides (LRE/RLE/PDF/LRO/RLO),
// bidi isolates (LRI/RLI/FSI/PDI), Arabic letter mark, BOM, and soft
// hyphen.
const NODE_LABEL_CONTROL_CHARS_RE =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: deliberately matching control chars + Unicode separators + bidi-overrides/isolates to neutralise log-injection / hidden-text vectors before rendering upstream-supplied strings
  /[\u0000-\u001f\u007f-\u009f\u00ad\ufeff\u061c\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;

function sanitiseNodeLabel(label: string): string {
  let stripped = label.replace(NODE_LABEL_CONTROL_CHARS_RE, " ");
  // Escape format delimiters to prevent a malicious label from rendering a
  // convincing fake entry in the summary.
  stripped = stripped
    .replace(/"/g, "'")
    .replace(/\(/g, "[")
    .replace(/\)/g, "]");
  stripped = stripped.trim();
  if (stripped.length > NODE_LABEL_MAX_CHARS) {
    return `${stripped.slice(0, NODE_LABEL_MAX_CHARS - 3)}...`;
  }
  return stripped;
}

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
  nodeId?: string;
  nodeLabel?: string;
  suggestion?: string;
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
    label?: unknown;
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

function nodeIdentity(
  node: WorkflowNodeForValidation,
  fallback: string
): { nodeId?: string; nodeLabel?: string } {
  const nodeId =
    typeof node.id === "string" && node.id !== "" ? node.id : undefined;
  const rawLabel = node.data?.label;
  const nodeLabel =
    typeof rawLabel === "string" && rawLabel !== "" ? rawLabel : nodeId;
  return {
    nodeId,
    nodeLabel: nodeLabel ?? fallback,
  };
}

// Best-effort "did you mean" for a mistyped actionType. Matches system action
// types (e.g. "condition" -> "Condition") and plugin action ids
// case-insensitively. Returns undefined when the input is empty.
let _candidateSet: Set<string> | undefined;
function suggestActionType(input: string): string | undefined {
  const normalized = input.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (!_candidateSet) {
    _candidateSet = new Set<string>();
    for (const action of getAllActions()) {
      _candidateSet.add(action.id);
    }
    for (const systemActionType of SYSTEM_ACTION_TYPES) {
      _candidateSet.add(systemActionType);
    }
  }
  for (const candidate of _candidateSet) {
    if (candidate.toLowerCase() === normalized) {
      return candidate;
    }
  }
  return undefined;
}

function isMissingRequiredValue(value: unknown): boolean {
  return value === undefined || value === null || value === "";
}

// Each entry inside a `call-list-builder` field (batch-write-contract,
// batch-read-contract) carries its own contract address, ABI, and function --
// the same three fields that are `required` on the equivalent standalone
// write-contract/read-contract node. Validated independently per call so an
// incomplete call added after a valid one is never silently treated as
// optional. Network is required too, but only when the field renders a
// per-row Network selector: batch-write-contract sets hideNetworkColumn and
// reads the action-level network instead, so a blank per-call network there
// is not a config error.
const BATCH_CALL_REQUIRED_FIELDS: Array<{
  key: "contractAddress" | "abi" | "abiFunction" | "network";
  label: string;
}> = [
  { key: "contractAddress", label: "Contract Address" },
  { key: "abi", label: "Contract ABI" },
  { key: "abiFunction", label: "Function" },
];

function parseBatchCalls(value: unknown): Record<string, unknown>[] {
  const parsed = Array.isArray(value) ? value : safeParseJsonArray(value);
  return parsed.filter(isRecord);
}

function safeParseJsonArray(value: unknown): unknown[] {
  if (typeof value !== "string" || value.trim() === "") {
    return [];
  }
  try {
    const result: unknown = JSON.parse(value);
    return Array.isArray(result) ? result : [];
  } catch {
    return [];
  }
}

export type BatchCallMissingField = {
  callIndex: number;
  fieldKey: "contractAddress" | "abi" | "abiFunction" | "network";
  fieldLabel: string;
};

export function getMissingBatchCallFields(
  callsValue: unknown,
  hideNetworkColumn?: boolean
): BatchCallMissingField[] {
  const requiredFields = hideNetworkColumn
    ? BATCH_CALL_REQUIRED_FIELDS
    : [
        ...BATCH_CALL_REQUIRED_FIELDS,
        { key: "network", label: "Network" } as const,
      ];
  const missing: BatchCallMissingField[] = [];
  for (const [callIndex, call] of parseBatchCalls(callsValue).entries()) {
    for (const { key, label } of requiredFields) {
      if (isMissingRequiredValue(call[key])) {
        missing.push({ callIndex, fieldKey: key, fieldLabel: label });
      }
    }
  }
  return missing;
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
      const suggestion = suggestActionType(actionType);
      const identity = nodeIdentity(node, `nodes[${nodeIndex}]`);
      issues.push({
        code: "UNKNOWN_ACTION_TYPE",
        path: `nodes[${nodeIndex}].data.config.actionType`,
        actionType,
        nodeId: identity.nodeId,
        nodeLabel: identity.nodeLabel,
        received: actionType,
        suggestion,
        message: suggestion
          ? `Unknown action type "${actionType}". Did you mean "${suggestion}"?`
          : `Unknown action type "${actionType}".`,
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

    const identity = nodeIdentity(node, `nodes[${nodeIndex}]`);
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
        nodeId: identity.nodeId,
        nodeLabel: identity.nodeLabel,
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
          nodeId: identity.nodeId,
          nodeLabel: identity.nodeLabel,
          expected: field.label,
          message: `Missing required field "${field.key}" for action "${actionType}".`,
        });
        continue;
      }

      if (field.type === "call-list-builder") {
        for (const missingCall of getMissingBatchCallFields(
          value,
          field.hideNetworkColumn
        )) {
          issues.push({
            code: "MISSING_REQUIRED_FIELD",
            path: `nodes[${nodeIndex}].data.config.${field.key}[${missingCall.callIndex}].${missingCall.fieldKey}`,
            actionType,
            field: `${field.key}[${missingCall.callIndex}].${missingCall.fieldKey}`,
            expected: missingCall.fieldLabel,
            message: `Missing required field "${missingCall.fieldLabel}" for call ${missingCall.callIndex + 1} on action "${actionType}".`,
          });
        }
      }

      const fieldCheck = validateFieldValue(field, value);
      if (!fieldCheck.valid) {
        issues.push({
          code: "INVALID_FIELD_TYPE",
          path: `nodes[${nodeIndex}].data.config.${field.key}`,
          actionType,
          field: field.key,
          nodeId: identity.nodeId,
          nodeLabel: identity.nodeLabel,
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
  const summary =
    validation.issues.length > 0
      ? (() => {
          const labels = new Map<string, { count: number; fallback: string }>();
          for (const issue of validation.issues) {
            const raw = issue.nodeLabel ?? issue.nodeId ?? issue.path;
            const existing = labels.get(raw);
            if (existing) {
              existing.count++;
            } else {
              labels.set(raw, {
                count: 1,
                fallback: issue.nodeId ?? issue.path,
              });
            }
          }
          const entries: string[] = [];
          let shown = 0;
          for (const [raw, { count, fallback }] of labels) {
            if (shown >= 3) {
              entries.push(`and ${labels.size - 3} more`);
              break;
            }
            let label = sanitiseNodeLabel(raw);
            if (!label.trim()) {
              label = fallback;
            }
            entries.push(
              count > 1 ? `"${label}" (${count} issues)` : `"${label}"`
            );
            shown++;
          }
          return `Invalid node(s): ${entries.join(", ")}. `;
        })()
      : "";
  return {
    error: "INVALID_ACTION_CONFIG",
    message: `Workflow contains invalid action configuration. ${summary}Fix the listed fields and save again.`,
    invalidFields: validation.issues,
  };
}
