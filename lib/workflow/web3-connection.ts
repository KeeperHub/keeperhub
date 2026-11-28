/**
 * Which actions read the per-node Web3 Connection (`config.web3Connection`).
 *
 * Only these steps pass the value to `resolveSignerForNode`. Every other step,
 * protocol writes included, signs under org policy and never reads it, so the
 * key is accepted on save, and the picker shown, only for these.
 * tests/unit/web3-connection-actions.test.ts ties this list to the step code.
 */
import { getChainIdFromNetwork } from "@/lib/rpc/network-utils";
import { isSolanaChain } from "@/lib/rpc/solana-chains";
import { SENDER_NOT_CHOSEN } from "@/lib/safe/sender-not-chosen";
import { LEGACY_ACTION_MAPPINGS } from "@/plugins/legacy-mappings";

export const WEB3_CONNECTION_KEY = "web3Connection";

const BATCH_WRITE_CONTRACT = "web3/batch-write-contract";
const TRANSFER_FUNDS = "web3/transfer-funds";
const SIGN_TYPED_DATA = "web3/sign-typed-data";
const SOLANA_WRITE_ACTION_TYPES: ReadonlySet<string> = new Set([
  "web3/transfer-spl-token",
  "web3/send-raw-solana-instruction",
  "web3/call-solana-program-anchor",
]);

const WEB3_CONNECTION_ACTION_TYPES: ReadonlySet<string> = new Set([
  "web3/write-contract",
  BATCH_WRITE_CONTRACT,
  "web3/approve-token",
  TRANSFER_FUNDS,
  "web3/transfer-token",
  "robinhood/trade-stock-token",
]);

// Legacy ids ("Write Contract", "Transfer Funds") still run the same steps.
function canonicalActionType(actionType: unknown): string | undefined {
  if (typeof actionType !== "string") {
    return;
  }
  return LEGACY_ACTION_MAPPINGS[actionType] ?? actionType;
}

export function actionTakesWeb3Connection(actionType: unknown): boolean {
  const id = canonicalActionType(actionType);
  return id !== undefined && WEB3_CONNECTION_ACTION_TYPES.has(id);
}

/** Batch Write Contract sends every call from the EOA, so it takes no Safe. */
export function actionTakesSafeSender(actionType: unknown): boolean {
  return (
    actionTakesWeb3Connection(actionType) &&
    canonicalActionType(actionType) !== BATCH_WRITE_CONTRACT
  );
}

// The id shape of `safe_wallets.id`; a template or whitespace never matches.
const SAFE_CONNECTION = /^safe:[A-Za-z0-9_-]+$/;

/**
 * Empty, default, eoa, safe:<id>, or the needs-sender mark a copy leaves. A
 * template anywhere is refused.
 */
export function isValidWeb3Connection(value: unknown): boolean {
  if (typeof value !== "string") {
    return false;
  }
  return (
    value === "" ||
    value === "default" ||
    value === "eoa" ||
    value === SENDER_NOT_CHOSEN ||
    SAFE_CONNECTION.test(value)
  );
}

export function isSafeWeb3Connection(value: unknown): boolean {
  return typeof value === "string" && value.startsWith("safe:");
}

/**
 * Drops a Web3 Connection the step would ignore (a Solana transfer included),
 * so it never looks chosen, and a `null` one, so "unset" has one form.
 */
export function withoutIgnoredWeb3Connection(
  config: Record<string, unknown>
): Record<string, unknown> {
  if (
    !(WEB3_CONNECTION_KEY in config) ||
    (config[WEB3_CONNECTION_KEY] !== null &&
      stepTakesWeb3Connection(config.actionType, config.network))
  ) {
    return config;
  }
  const { [WEB3_CONNECTION_KEY]: _ignored, ...rest } = config;
  return rest;
}

/** Empty, default and null all mean the policy sender. */
export function isUnsetWeb3Connection(value: unknown): boolean {
  return value === "" || value === "default" || value === null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * For a copy into another organization: drops every Web3 Connection except a
 * valid Safe, or the no-sender mark, on a step that takes a Safe.
 */
export function withOnlySafeWeb3Connections<T>(nodes: T[]): T[] {
  return nodes.map((node) => {
    if (!isRecord(node)) {
      return node;
    }
    const data = node.data;
    if (!(isRecord(data) && isRecord(data.config))) {
      return node;
    }
    if (!(WEB3_CONNECTION_KEY in data.config)) {
      return node;
    }
    const value = data.config[WEB3_CONNECTION_KEY];
    if (
      ((isValidWeb3Connection(value) && isSafeWeb3Connection(value)) ||
        value === SENDER_NOT_CHOSEN) &&
      actionTakesSafeSender(data.config.actionType)
    ) {
      return node;
    }
    const { [WEB3_CONNECTION_KEY]: _dropped, ...config } = data.config;
    return { ...node, data: { ...data, config } };
  });
}

/**
 * The nodes with every ignored Web3 Connection dropped, so an editor save
 * never sends a stale one the server would refuse.
 */
export function withoutIgnoredWeb3Connections<T>(nodes: T[]): T[] {
  return nodes.map((node) => {
    if (!isRecord(node) || node.type === "trigger") {
      return node;
    }
    const data = node.data;
    if (!(isRecord(data) && isRecord(data.config))) {
      return node;
    }
    const config = withoutIgnoredWeb3Connection(data.config);
    return config === data.config
      ? node
      : ({ ...node, data: { ...data, config } } as T);
  });
}

function isSolanaNetwork(network: unknown): boolean {
  if (typeof network !== "string" && typeof network !== "number") {
    return false;
  }
  try {
    return isSolanaChain(getChainIdFromNetwork(network));
  } catch {
    // A template or unknown network is not a known Solana chain.
    return false;
  }
}

/**
 * Whether this step's run reads the Web3 Connection: an action that takes it,
 * and for Transfer Native Token a network that is not a known Solana chain.
 * The editor shows the picker exactly here (fixedSenderNote is null).
 */
export function stepTakesWeb3Connection(
  actionType: unknown,
  network: unknown
): boolean {
  return (
    actionTakesWeb3Connection(actionType) &&
    !(
      canonicalActionType(actionType) === TRANSFER_FUNDS &&
      isSolanaNetwork(network)
    )
  );
}

/**
 * The read-only line the editor shows instead of the picker on a web3 step
 * whose sender is fixed, or null when the picker applies.
 */
export function fixedSenderNote(
  actionType: unknown,
  network: unknown
): string | null {
  const id = canonicalActionType(actionType);
  if (id === SIGN_TYPED_DATA) {
    return "Signed by your organization's EOA";
  }
  if (
    (id !== undefined && SOLANA_WRITE_ACTION_TYPES.has(id)) ||
    (id === TRANSFER_FUNDS && isSolanaNetwork(network))
  ) {
    return "Sent from your organization's Solana wallet";
  }
  if (stepTakesWeb3Connection(id, network)) {
    return null;
  }
  return "Sent from your Default Sender (organization policy)";
}

const ANY_SENDER = 'empty, "default", "eoa" or "safe:<safeWalletId>"';

/** Why a value cannot be saved on this action, or null when it can. */
export function web3ConnectionProblem(
  actionType: string,
  value: unknown
): { expected: string; message: string } | null {
  if (value === undefined) {
    return null;
  }
  if (!isValidWeb3Connection(value)) {
    return {
      expected: ANY_SENDER,
      message: `Web3 Connection must be ${ANY_SENDER}, with no templates, on action "${actionType}".`,
    };
  }
  if (isSafeWeb3Connection(value) && !actionTakesSafeSender(actionType)) {
    return {
      expected: 'empty, "default" or "eoa"',
      message: `Web3 Connection cannot be a Safe on action "${actionType}": Batch Write Contract sends every call from your EOA.`,
    };
  }
  return null;
}

/** Whether a step that reads its Web3 Connection still waits for a sender. */
export function stepNeedsSender(config: unknown): boolean {
  if (!isRecord(config)) {
    return false;
  }
  return (
    config[WEB3_CONNECTION_KEY] === SENDER_NOT_CHOSEN &&
    stepTakesWeb3Connection(config.actionType, config.network)
  );
}
