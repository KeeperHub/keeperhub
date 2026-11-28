/**
 * While a stored workflow has a step that sends from the EOA, only the editor
 * may change it. An API key or OAuth caller may send it back as stored, or, in
 * a request of its own, remove the EOA choice. Exposure may only shrink.
 */
import { stableStringify } from "@/lib/stable-json";
import { stripControlChars } from "@/lib/utils/control-chars";
import { cutText } from "@/lib/utils/cut-text";
import { sanitizeNodesKeepingWeb3Connection } from "@/lib/workflow/editor/sanitize-nodes";
import type { ActionConfigValidationResult } from "@/lib/workflow/validation/action-config";
import {
  stepTakesWeb3Connection,
  WEB3_CONNECTION_KEY,
} from "@/lib/workflow/web3-connection";

const NAMED_STEPS_MAX = 3;
const STEP_ID_MAX_CHARS = 64;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function dataOf(node: Record<string, unknown>): Record<string, unknown> {
  return isRecord(node.data) ? node.data : {};
}

function configOf(node: Record<string, unknown>): Record<string, unknown> {
  const config = dataOf(node).config;
  return isRecord(config) ? config : {};
}

function sendsFromEoa(node: Record<string, unknown>): boolean {
  const config = configOf(node);
  return (
    config[WEB3_CONNECTION_KEY] === "eoa" &&
    stepTakesWeb3Connection(config.actionType, config.network)
  );
}

function sanitized(nodes: readonly unknown[]): Record<string, unknown>[] {
  return sanitizeNodesKeepingWeb3Connection(nodes.filter(isRecord));
}

/** The ids of the stored steps that send from the EOA. */
function eoaStepIds(storedNodes: unknown): string[] {
  if (!Array.isArray(storedNodes)) {
    return [];
  }
  return sanitized(storedNodes)
    .filter(sendsFromEoa)
    .map((node) => String(node.id));
}

export function eoaWorkflowLockedMessage(
  stepIds: readonly string[],
  exposure = false
): string {
  const named = stepIds
    .slice(0, NAMED_STEPS_MAX)
    .map((id) => `"${cutText(stripControlChars(id), STEP_ID_MAX_CHARS)}"`)
    .join(", ");
  const more = stepIds.length > NAMED_STEPS_MAX ? ", ..." : "";
  const widen = exposure
    ? ", and API and MCP callers cannot list it, price it or make it more visible"
    : "";
  return `This workflow has a step that sends from the EOA (${named}${more}), so only someone in the editor can change it${widen}. Ask the user to make this change in the editor. API and MCP callers can send the workflow back exactly as stored, or, in a request of its own, remove the EOA choice (set those steps to default or a Safe, or delete them; Batch Write Contract takes default only), which changes the wallet they send from.`;
}

function lockedResult(
  stepIds: readonly string[],
  path: string,
  nodeId?: string,
  exposure = false
): ActionConfigValidationResult {
  return {
    valid: false,
    issues: [
      {
        code: "INVALID_FIELD_VALUE",
        path,
        field: WEB3_CONNECTION_KEY,
        nodeId,
        message: eoaWorkflowLockedMessage(stepIds, exposure),
      },
    ],
  };
}

function rawIds(value: unknown, ids: Set<string>): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) {
      rawIds(item, ids);
    }
  } else if (isRecord(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (key === "id" && typeof item === "string") {
        ids.add(item);
      }
      rawIds(item, ids);
    }
  }
  return ids;
}

// Drops condition rule and group ids the sanitizer generated for a row that
// had none, so a round trip of an old row compares equal.
function withoutGeneratedIds(value: unknown, kept: Set<string>): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => withoutGeneratedIds(item, kept));
  }
  if (!isRecord(value)) {
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === "id" && typeof item === "string" && !kept.has(item)) {
      continue;
    }
    out[key] = withoutGeneratedIds(item, kept);
  }
  return out;
}

// What the run reads: type, label (template refs resolve by label), config
// and enabled flag. Description and position are free.
function nodeRunShape(
  raw: Record<string, unknown>,
  node: Record<string, unknown>,
  dropPin: boolean
): string {
  const { [WEB3_CONNECTION_KEY]: _pin, ...unpinned } = configOf(node);
  const config = dropPin ? unpinned : { ...configOf(node) };
  if (config.conditionConfig !== undefined) {
    config.conditionConfig = withoutGeneratedIds(
      config.conditionConfig,
      rawIds(raw, new Set())
    );
  }
  return stableStringify({
    type: node.type,
    label: dataOf(node).label,
    config,
    disabled: dataOf(node).enabled === false,
  });
}

type IndexedNode = {
  index: number;
  raw: Record<string, unknown>;
  node: Record<string, unknown>;
};

// Each node by id, or the index of the first one without a unique id.
function byId(nodes: readonly unknown[]): Map<string, IndexedNode> | number {
  const notRecord = nodes.findIndex((node) => !isRecord(node));
  if (notRecord !== -1) {
    return notRecord;
  }
  const raws = nodes as Record<string, unknown>[];
  const clean = sanitizeNodesKeepingWeb3Connection(raws);
  const out = new Map<string, IndexedNode>();
  for (const [index, node] of clean.entries()) {
    if (typeof node.id !== "string" || out.has(node.id)) {
      return index;
    }
    out.set(node.id, { index, raw: raws[index], node });
  }
  return out;
}

function edgeShapes(
  edges: readonly unknown[],
  deleted: ReadonlySet<string>
): string[] {
  const shapes: string[] = [];
  for (const edge of edges) {
    if (!isRecord(edge)) {
      shapes.push(stableStringify(edge));
      continue;
    }
    if (deleted.has(String(edge.source)) || deleted.has(String(edge.target))) {
      continue;
    }
    shapes.push(
      stableStringify({
        source: edge.source,
        target: edge.target,
        sourceHandle: edge.sourceHandle ?? null,
        targetHandle: edge.targetHandle ?? null,
      })
    );
  }
  return shapes.sort();
}

type Difference = { path: string; nodeId?: string };

function nodeDifference(
  incoming: unknown,
  storedNodes: readonly unknown[],
  storedEoa: ReadonlySet<string>,
  deleted: Set<string>
): Difference | null {
  if (!Array.isArray(incoming)) {
    return { path: "nodes" };
  }
  const stored = byId(storedNodes);
  const sent = byId(incoming);
  if (typeof sent === "number") {
    return { path: `nodes[${sent}]` };
  }
  if (typeof stored === "number") {
    return { path: "nodes" };
  }
  for (const id of stored.keys()) {
    if (!sent.has(id)) {
      if (!storedEoa.has(id)) {
        return { path: "nodes", nodeId: id };
      }
      deleted.add(id);
    }
  }
  for (const [id, { index, raw, node }] of sent) {
    const before = stored.get(id);
    const dropPin = storedEoa.has(id) && !sendsFromEoa(node);
    if (
      !before ||
      nodeRunShape(before.raw, before.node, dropPin) !==
        nodeRunShape(raw, node, dropPin)
    ) {
      return { path: `nodes[${index}]`, nodeId: id };
    }
  }
  return null;
}

export type EoaWorkflowLockCheck = {
  // The request's nodes and edges as sent; the stored ones when left out.
  incomingNodes: unknown;
  incomingEdges: unknown;
  storedNodes: readonly unknown[];
  storedEdges: readonly unknown[];
};

/**
 * For an API key or OAuth caller: while the stored workflow has a step that
 * sends from the EOA, every node (type, label, config, enabled) and edge must
 * stay as stored, except that EOA pins may be removed (set to default or a
 * Safe, or the step deleted) and nothing else in that request.
 */
export function validateEoaWorkflowLock(
  check: EoaWorkflowLockCheck
): ActionConfigValidationResult {
  const stepIds = eoaStepIds(check.storedNodes);
  if (stepIds.length === 0) {
    return { valid: true, issues: [] };
  }
  const deleted = new Set<string>();
  const changed = nodeDifference(
    check.incomingNodes,
    check.storedNodes,
    new Set(stepIds),
    deleted
  );
  if (changed) {
    return lockedResult(stepIds, changed.path, changed.nodeId);
  }
  if (
    !Array.isArray(check.incomingEdges) ||
    stableStringify(edgeShapes(check.storedEdges, deleted)) !==
      stableStringify(edgeShapes(check.incomingEdges, deleted))
  ) {
    return lockedResult(stepIds, "edges");
  }
  return { valid: true, issues: [] };
}

const VISIBILITY_RANK: Record<string, number> = {
  private: 0,
  unlisted: 1,
  public: 2,
};

export type StoredExposure = {
  nodes: unknown;
  isListed?: unknown;
  priceUsdcPerCall?: unknown;
  inputSchema?: unknown;
  outputMapping?: unknown;
  visibility?: unknown;
};

function changes(sent: unknown, stored: unknown): boolean {
  return (
    sent !== undefined &&
    stableStringify(sent) !== stableStringify(stored ?? null)
  );
}

// Prices compare as numbers; null and missing are equal.
function priceChanges(sent: unknown, stored: unknown): boolean {
  if (sent === undefined || (sent === null && stored == null)) {
    return false;
  }
  return sent === null || stored == null || Number(sent) !== Number(stored);
}

function widenedSetting(
  stored: StoredExposure,
  body: Record<string, unknown>
): string | null {
  if (body.isListed === true && stored.isListed !== true) {
    return "isListed";
  }
  if (priceChanges(body.priceUsdcPerCall, stored.priceUsdcPerCall)) {
    return "priceUsdcPerCall";
  }
  for (const key of ["inputSchema", "outputMapping"] as const) {
    if (changes(body[key], stored[key])) {
      return key;
    }
  }
  const to = VISIBILITY_RANK[String(body.visibility)];
  const from = VISIBILITY_RANK[String(stored.visibility)] ?? 0;
  if (to !== undefined && to > from) {
    return "visibility";
  }
  return null;
}

/**
 * For an API key or OAuth caller on a workflow with an EOA step: refuses a
 * setting that widens who can trigger it or with what. Pausing, unlisting,
 * making it private, renaming, tags and project stay free.
 */
export function validateEoaExposureLock(
  stored: StoredExposure,
  body: Record<string, unknown>
): ActionConfigValidationResult {
  const stepIds = eoaStepIds(stored.nodes);
  if (stepIds.length === 0) {
    return { valid: true, issues: [] };
  }
  const widened = widenedSetting(stored, body);
  return widened
    ? lockedResult(stepIds, widened, undefined, true)
    : { valid: true, issues: [] };
}
