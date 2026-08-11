/**
 * Human-readable semantic diff between two workflow snapshots, for the version
 * history UI. Compares nodes by id and edges by connectivity, ignoring cosmetic
 * canvas state (node position, selection) so a drag never shows as a change.
 * This replaces a raw JSON diff -- it answers "what changed", not "which bytes
 * differ".
 */

import { findAbiFunction } from "@/lib/abi/utils";
import { getActionLabel } from "@/lib/step-registry";
import {
  type ConditionGroup,
  type ConditionRule,
  isConditionGroup,
} from "@/lib/workflow/nodes/condition/builder-types";

type AnyRecord = Record<string, unknown>;

type Snapshotish = {
  name?: string | null;
  description?: string | null;
  visibility?: string | null;
  enabled?: boolean | null;
  nodes?: unknown;
  edges?: unknown;
};

export type SettingChange = {
  field: "name" | "description" | "visibility" | "enabled";
  before: string;
  after: string;
};

export type NodeRef = { id: string; label: string; nodeType: string };

export type ConfigChange = { key: string; before: string; after: string };

export type NodeFieldDelta = {
  field: "name" | "description" | "type" | "configuration" | "enabled";
  before?: string;
  after?: string;
  configKeys?: string[];
  // Per-field before/after for configuration changes (full values, so the
  // history UI can copy and visually compare them).
  configChanges?: ConfigChange[];
};

export type NodeFieldChange = {
  id: string;
  label: string;
  nodeType: string;
  // The action id (e.g. "web3/read-contract") so the UI can map config keys
  // to their human field labels.
  actionType?: string;
  // The node's configured chain id, so address values can link to the right
  // block explorer.
  chainId?: string;
  deltas: NodeFieldDelta[];
};

export type ConnectionRef = {
  from: string;
  to: string;
  // Stable node ids for the endpoints, so the per-node history can match a
  // connection to its node even after the node's label changed (labels are
  // what the user sees; ids never change). Optional: diffs recorded before
  // this field shipped carry only labels.
  fromId?: string;
  toId?: string;
};

export type VersionDiff = {
  settings: SettingChange[];
  nodesAdded: NodeRef[];
  nodesRemoved: NodeRef[];
  nodesChanged: NodeFieldChange[];
  connectionsAdded: ConnectionRef[];
  connectionsRemoved: ConnectionRef[];
  hasChanges: boolean;
};

function asArray(value: unknown): AnyRecord[] {
  return Array.isArray(value) ? (value as AnyRecord[]) : [];
}

function nodeLabel(node: AnyRecord): string {
  const data = (node.data ?? {}) as AnyRecord;
  const label = typeof data.label === "string" ? data.label.trim() : "";
  if (label) {
    return label;
  }
  const config = (data.config ?? {}) as AnyRecord;
  // Plugin actions resolve via getActionLabel (e.g. web3/read-contract ->
  // "Read Contract"); system actions ("Condition", "HTTP Request", ...) are
  // already their own label, so fall back to the raw actionType.
  if (typeof config.actionType === "string") {
    return getActionLabel(config.actionType) ?? config.actionType;
  }
  if (typeof config.triggerType === "string") {
    return config.triggerType;
  }
  // Unconfigured node (no action picked yet): present the category capitalized
  // ("action" -> "Action") rather than the raw lowercase type.
  const rawType =
    (typeof data.type === "string" ? data.type : "") ||
    (typeof node.type === "string" ? node.type : "") ||
    "node";
  return rawType.charAt(0).toUpperCase() + rawType.slice(1);
}

function nodeType(node: AnyRecord): string {
  const data = (node.data ?? {}) as AnyRecord;
  if (typeof data.type === "string") {
    return data.type;
  }
  return typeof node.type === "string" ? node.type : "step";
}

function nodeActionType(node: AnyRecord): string | undefined {
  const config = ((node.data ?? {}) as AnyRecord).config as
    | AnyRecord
    | undefined;
  const actionType = config?.actionType;
  return typeof actionType === "string" ? actionType : undefined;
}

function nodeChainId(node: AnyRecord): string | undefined {
  const config = ((node.data ?? {}) as AnyRecord).config as
    | AnyRecord
    | undefined;
  const raw = config?.network ?? config?.chainId ?? config?.chain;
  if (typeof raw === "string" || typeof raw === "number") {
    return String(raw);
  }
  return;
}

// Template refs persist as `{{@nodeId:Display.field}}`; the node id is noise in
// a human diff, so collapse them to `{{Display.field}}`.
const TEMPLATE_REF = /\{\{@[^:}]+:([^}]+)\}\}/g;

function cleanTemplateRefs(text: string): string {
  return text.replace(TEMPLATE_REF, "{{$1}}");
}

function byId(nodes: AnyRecord[]): Map<string, AnyRecord> {
  const map = new Map<string, AnyRecord>();
  for (const n of nodes) {
    if (typeof n.id === "string") {
      map.set(n.id, n);
    }
  }
  return map;
}

// The full value is kept (not truncated) so the history UI can copy and
// visually compare long values; only node-id noise in template refs is stripped.
function configValueText(value: unknown): string {
  if (value === undefined || value === null || value === "") {
    return "empty";
  }
  const raw = typeof value === "string" ? value : JSON.stringify(value);
  return cleanTemplateRefs(raw);
}

// A web3 contract call stores its arguments as a positional JSON array, which
// on its own reads as `["","0333..."]`. Pair each value with its ABI parameter
// name (resolved from the same node's `abi` + `abiFunction`) so the diff shows
// what each argument is. Returns null when the value isn't a parseable arg
// array, so the caller falls back to the raw text.
function namedContractArgs(
  config: AnyRecord,
  argsValue: unknown
): string | null {
  let args: unknown;
  try {
    args = typeof argsValue === "string" ? JSON.parse(argsValue) : argsValue;
  } catch {
    return null;
  }
  if (!Array.isArray(args)) {
    return null;
  }
  let inputs: Array<{ name?: string }> = [];
  const abiRaw = config.abi;
  const fnKey = config.abiFunction;
  if (typeof abiRaw === "string" && typeof fnKey === "string") {
    try {
      const abi = JSON.parse(abiRaw);
      if (Array.isArray(abi)) {
        inputs = findAbiFunction(abi, fnKey)?.inputs ?? [];
      }
    } catch {
      // Unparseable ABI: fall back to positional arg names below.
    }
  }
  // Drop the trailing empty-string padding the UI appends past the real params.
  const effective =
    inputs.length > 0 && args.length > inputs.length
      ? args.slice(0, inputs.length)
      : args;
  const named: Record<string, unknown> = {};
  for (const [i, value] of effective.entries()) {
    named[inputs[i]?.name?.trim() || `arg${i}`] = value;
  }
  // Pretty-print so the history UI shows one named argument per line.
  return cleanTemplateRefs(JSON.stringify(named, null, 2));
}

function conditionRuleText(rule: ConditionRule): string {
  const left = rule.leftOperand?.trim() || '""';
  const right = rule.rightOperand?.trim();
  // Unary operators (isEmpty, exists, ...) carry no right operand.
  return right
    ? `${left} ${rule.operator} ${right}`
    : `${left} ${rule.operator}`;
}

// Append a group's rules as a numbered list with the AND/OR operator placed
// between consecutive rules, mirroring the visual builder (where the operator
// sits between the conditions it joins) instead of a single JSON blob.
function appendConditionGroup(
  lines: string[],
  group: ConditionGroup,
  depth: number
): void {
  const pad = "  ".repeat(depth);
  const logic = group.logic ?? "AND";
  const rules = Array.isArray(group.rules) ? group.rules : [];
  for (const [i, item] of rules.entries()) {
    if (i > 0) {
      lines.push(`${pad}${logic}`);
    }
    if (isConditionGroup(item)) {
      lines.push(`${pad}${i + 1}. group`);
      appendConditionGroup(lines, item, depth + 1);
    } else {
      lines.push(`${pad}${i + 1}. ${conditionRuleText(item)}`);
    }
  }
}

// A Condition node's `conditionConfig` is the visual builder state; on its own
// it reads as a dense JSON object. Render it as an ordered rule list so the
// history diff is legible and the rule order is preserved.
function namedConditionConfig(value: unknown): string | null {
  let parsed: unknown;
  try {
    parsed = typeof value === "string" ? JSON.parse(value) : value;
  } catch {
    return null;
  }
  const group = (parsed as { group?: ConditionGroup } | null)?.group;
  if (!(group && Array.isArray(group.rules))) {
    return null;
  }
  const lines: string[] = [];
  appendConditionGroup(lines, group, 0);
  return cleanTemplateRefs(lines.join("\n"));
}

function configChangeValue(
  config: AnyRecord,
  key: string,
  value: unknown
): string {
  if (key === "functionArgs") {
    return namedContractArgs(config, value) ?? configValueText(value);
  }
  if (key === "conditionConfig") {
    return namedConditionConfig(value) ?? configValueText(value);
  }
  return configValueText(value);
}

function changedConfigDetails(
  before: AnyRecord,
  after: AnyRecord
): ConfigChange[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const changed: ConfigChange[] = [];
  for (const key of keys) {
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
      changed.push({
        key,
        before: configChangeValue(before, key, before[key]),
        after: configChangeValue(after, key, after[key]),
      });
    }
  }
  return changed;
}

function buildNodeDeltas(
  before: AnyRecord,
  after: AnyRecord
): NodeFieldDelta[] {
  const bd = (before.data ?? {}) as AnyRecord;
  const ad = (after.data ?? {}) as AnyRecord;
  const deltas: NodeFieldDelta[] = [];

  const bLabel = typeof bd.label === "string" ? bd.label : "";
  const aLabel = typeof ad.label === "string" ? ad.label : "";
  if (bLabel !== aLabel) {
    deltas.push({ field: "name", before: bLabel, after: aLabel });
  }

  const bDesc = typeof bd.description === "string" ? bd.description : "";
  const aDesc = typeof ad.description === "string" ? ad.description : "";
  if (bDesc !== aDesc) {
    deltas.push({ field: "description", before: bDesc, after: aDesc });
  }

  if (nodeType(before) !== nodeType(after)) {
    deltas.push({
      field: "type",
      before: nodeType(before),
      after: nodeType(after),
    });
  }

  const bConfig = (bd.config ?? {}) as AnyRecord;
  const aConfig = (ad.config ?? {}) as AnyRecord;
  const configChanges = changedConfigDetails(bConfig, aConfig);
  if (configChanges.length > 0) {
    deltas.push({
      field: "configuration",
      configKeys: configChanges.map((c) => c.key),
      configChanges,
    });
  }

  const bEnabled = bd.enabled ?? true;
  const aEnabled = ad.enabled ?? true;
  if (bEnabled !== aEnabled) {
    deltas.push({
      field: "enabled",
      before: String(bEnabled),
      after: String(aEnabled),
    });
  }

  return deltas;
}

function edgeKey(edge: AnyRecord): string {
  return [
    edge.source,
    edge.target,
    edge.sourceHandle ?? "",
    edge.targetHandle ?? "",
  ].join("|");
}

function connectionRef(
  edge: AnyRecord,
  labels: Map<string, string>
): ConnectionRef {
  const fromId = String(edge.source);
  const toId = String(edge.target);
  return {
    from: labels.get(fromId) ?? fromId,
    to: labels.get(toId) ?? toId,
    fromId,
    toId,
  };
}

function diffSettings(
  before: Snapshotish,
  after: Snapshotish
): SettingChange[] {
  const out: SettingChange[] = [];
  const fields: SettingChange["field"][] = [
    "name",
    "description",
    "visibility",
    "enabled",
  ];
  for (const field of fields) {
    const b = before[field] ?? "";
    const a = after[field] ?? "";
    if (String(b) !== String(a)) {
      out.push({ field, before: String(b), after: String(a) });
    }
  }
  return out;
}

export function computeVersionDiff(
  before: Snapshotish | null,
  after: Snapshotish
): VersionDiff {
  const empty: VersionDiff = {
    settings: [],
    nodesAdded: [],
    nodesRemoved: [],
    nodesChanged: [],
    connectionsAdded: [],
    connectionsRemoved: [],
    hasChanges: false,
  };
  if (!before) {
    return empty;
  }

  const beforeNodes = byId(asArray(before.nodes));
  const afterNodes = byId(asArray(after.nodes));

  const nodesAdded: NodeRef[] = [];
  const nodesRemoved: NodeRef[] = [];
  const nodesChanged: NodeFieldChange[] = [];

  for (const [id, node] of afterNodes) {
    const prev = beforeNodes.get(id);
    if (!prev) {
      nodesAdded.push({ id, label: nodeLabel(node), nodeType: nodeType(node) });
      continue;
    }
    const deltas = buildNodeDeltas(prev, node);
    if (deltas.length > 0) {
      nodesChanged.push({
        id,
        label: nodeLabel(node),
        nodeType: nodeType(node),
        actionType: nodeActionType(node),
        chainId: nodeChainId(node),
        deltas,
      });
    }
  }
  for (const [id, node] of beforeNodes) {
    if (!afterNodes.has(id)) {
      nodesRemoved.push({
        id,
        label: nodeLabel(node),
        nodeType: nodeType(node),
      });
    }
  }

  // Connection labels resolve to the node's display name in whichever snapshot
  // knows it (after preferred, before as fallback for removed connections).
  const labels = new Map<string, string>();
  for (const [id, n] of beforeNodes) {
    labels.set(id, nodeLabel(n));
  }
  for (const [id, n] of afterNodes) {
    labels.set(id, nodeLabel(n));
  }

  const beforeEdges = new Map(
    asArray(before.edges).map((e) => [edgeKey(e), e])
  );
  const afterEdges = new Map(asArray(after.edges).map((e) => [edgeKey(e), e]));
  const connectionsAdded: ConnectionRef[] = [];
  const connectionsRemoved: ConnectionRef[] = [];
  for (const [key, edge] of afterEdges) {
    if (!beforeEdges.has(key)) {
      connectionsAdded.push(connectionRef(edge, labels));
    }
  }
  for (const [key, edge] of beforeEdges) {
    if (!afterEdges.has(key)) {
      connectionsRemoved.push(connectionRef(edge, labels));
    }
  }

  const settings = diffSettings(before, after);
  const hasChanges =
    settings.length > 0 ||
    nodesAdded.length > 0 ||
    nodesRemoved.length > 0 ||
    nodesChanged.length > 0 ||
    connectionsAdded.length > 0 ||
    connectionsRemoved.length > 0;

  return {
    settings,
    nodesAdded,
    nodesRemoved,
    nodesChanged,
    connectionsAdded,
    connectionsRemoved,
    hasChanges,
  };
}
