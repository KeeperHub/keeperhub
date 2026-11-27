// A copied step pinned to a Safe the copier's organization does not own
// ("safe:<id>") is left with no sender, and the copy names it.
import { SENDER_NOT_CHOSEN } from "@/lib/safe/sender-not-chosen";
import { cutText } from "@/lib/utils/cut-text";
import {
  actionTakesSafeSender,
  stepNeedsSender,
  stepTakesWeb3Connection,
  withOnlySafeWeb3Connections,
  withoutIgnoredWeb3Connection,
} from "@/lib/workflow/web3-connection";
import { findActionById } from "@/plugins/registry";

export type StepNeedingSender = { nodeId: string; label: string };

const SAFE_PREFIX = "safe:";
// How many step names the notice quotes, and how much of each.
const NOTICE_MAX_NAMES = 3;
const NOTICE_LABEL_MAX_CHARS = 40;

type NodeLike = Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function configOf(node: NodeLike): Record<string, unknown> | null {
  const data = node.data;
  return isRecord(data) && isRecord(data.config) ? data.config : null;
}

// The step's Web3 Connection, only on a step that can send from a Safe.
function connectionOf(node: NodeLike): string | null {
  const config = configOf(node);
  if (
    !(
      config &&
      stepTakesWeb3Connection(config.actionType, config.network) &&
      actionTakesSafeSender(config.actionType)
    )
  ) {
    return null;
  }
  const connection = config.web3Connection;
  return typeof connection === "string" ? connection : null;
}

// The Safe id a step is pinned to: "" for a malformed "safe:", null for none.
function pinnedSafeId(node: NodeLike): string | null {
  const connection = connectionOf(node);
  if (connection === null || !connection.startsWith(SAFE_PREFIX)) {
    return null;
  }
  return connection.slice(SAFE_PREFIX.length);
}

/** The distinct Safe ids the steps are pinned to. */
export function pinnedSafeIds(nodes: readonly NodeLike[]): string[] {
  const ids = new Set<string>();
  for (const node of nodes) {
    const id = pinnedSafeId(node);
    if (id) {
      ids.add(id);
    }
  }
  return [...ids];
}

// The step's own label, else its action's name; never a raw id.
function stepLabel(node: NodeLike): string {
  const data = isRecord(node.data) ? node.data : {};
  if (typeof data.label === "string" && data.label.trim() !== "") {
    return data.label.trim();
  }
  const actionType = isRecord(data.config) ? data.config.actionType : undefined;
  const action =
    typeof actionType === "string" ? findActionById(actionType) : undefined;
  return action?.label ?? "Unnamed step";
}

function withConfig(node: NodeLike, config: Record<string, unknown>): NodeLike {
  return { ...node, data: { ...(node.data as NodeLike), config } };
}

/** The enabled steps that wait for a sender, as the editor's checks see them. */
export function listStepsNeedingSender(
  nodes: readonly NodeLike[]
): StepNeedingSender[] {
  return nodes
    .filter((node) => {
      const data = isRecord(node.data) ? node.data : {};
      return data.enabled !== false && stepNeedsSender(data.config);
    })
    .map((node) => ({ nodeId: String(node.id), label: stepLabel(node) }));
}

/**
 * The copy rule into another organization: drops eoa and default, keeps a Safe
 * in `ownedSafeIds`, and leaves a step on any other Safe with no sender. A step
 * that takes no Safe (Batch, a Solana transfer, a protocol write) loses it.
 */
export function unsetUnownedSafes(
  nodes: readonly NodeLike[],
  ownedSafeIds: ReadonlySet<string>
): { nodes: NodeLike[]; needingSender: StepNeedingSender[] } {
  const next = withOnlySafeWeb3Connections([...nodes]).map((node) => {
    const config = configOf(node);
    if (!config) {
      return node;
    }
    const kept = withoutIgnoredWeb3Connection(config);
    if (kept !== config) {
      return withConfig(node, kept);
    }
    const id = pinnedSafeId(node);
    if (id === null || (id !== "" && ownedSafeIds.has(id))) {
      return node;
    }
    return withConfig(node, { ...config, web3Connection: SENDER_NOT_CHOSEN });
  });
  return { nodes: next, needingSender: listStepsNeedingSender(next) };
}

function quotedName(label: string): string {
  const cut =
    label.length > NOTICE_LABEL_MAX_CHARS
      ? `${cutText(label, NOTICE_LABEL_MAX_CHARS - 1).trimEnd()}…`
      : label;
  return `"${cut}"`;
}

// "A", "A and B", "A, B and C", "A, B, C and 2 more".
function nameList(steps: readonly StepNeedingSender[]): string {
  const names = steps
    .slice(0, NOTICE_MAX_NAMES)
    .map((step) => quotedName(step.label));
  const more = steps.length - names.length;
  if (more > 0) {
    return `${names.join(", ")} and ${more} more`;
  }
  if (names.length === 1) {
    return names[0];
  }
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/**
 * The notice after a copy or import with steps that need a sender; null when
 * none do. Neutral on where the Safe came from, so a same-org copy reads right.
 */
export function stepsNeedingSenderNotice(
  steps: readonly StepNeedingSender[]
): string | null {
  if (steps.length === 0) {
    return null;
  }
  const one = steps.length === 1;
  const count = one ? "1 step" : `${steps.length} steps`;
  const need = one ? "needs" : "need";
  const where = one ? "that step" : "each step";
  return `${count} used a Safe your organization does not own and ${need} a sender: ${nameList(steps)}. Pick one under Web3 Connection in ${where} before running.`;
}
