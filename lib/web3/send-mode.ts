// "Send as", stored as `sendMode`; the old `usePrivateMempool` flag is still read.
// Shared by the editor, save checks and the step cores.

export const SEND_MODE = {
  TRANSACTION: "transaction",
  PRIVATE_RELAY: "private-relay",
} as const;

export type SendMode = (typeof SEND_MODE)[keyof typeof SEND_MODE];

/** What a chain offers, as /api/chains reports it. */
export type SendModeChain = { usePrivateMempoolRpc?: boolean | null };

/** A chain row has a relay only with the flag on and a relay URL set. */
export function chainHasPrivateRelay(row: {
  usePrivateMempoolRpc?: boolean | null;
  defaultPrivateRpcUrl?: string | null;
}): boolean {
  return row.usePrivateMempoolRpc === true && Boolean(row.defaultPrivateRpcUrl);
}

/** How to switch a step to Normal, in the editor's words and the API's. */
const USE_NORMAL_HINT =
  'Set Send as to Normal transaction (sendMode: "transaction").';

/** The run-time refusal of Private relay on a chain without one. */
export function noPrivateRelayMessage(chainName: string): string {
  return `This step is set to Send as: Private relay, but ${chainName} has no private relay. ${USE_NORMAL_HINT}`;
}

type SendModeOption = {
  value: SendMode;
  label: string;
  /** For the closed field and hints; the menu shows `label`. */
  shortLabel: string;
  description: string;
  /** The line under the closed field; `description` when unset. */
  hint?: string;
  /** Short name for the canvas badge; none for Normal. */
  badge?: string;
  /** Whether the chain can send this way. */
  availableOn: (chain: SendModeChain | undefined) => boolean;
  /** Notice shown when picking this mode turns Sponsor gas off. */
  sponsorOffNotice?: string;
  /** Why a step set to this mode will not send so on a chain without it. */
  unavailableNotice?: (chainName: string, fallsBack: boolean) => string;
};

// Listed in menu order. A new mode is one more entry here.
export const SEND_MODE_OPTIONS: readonly SendModeOption[] = [
  {
    value: SEND_MODE.TRANSACTION,
    label: "Normal transaction",
    shortLabel: "Normal transaction",
    description:
      "Sent to the public mempool. Can be sponsored. A reverted send still pays gas.",
    availableOn: () => true,
  },
  {
    value: SEND_MODE.PRIVATE_RELAY,
    label: "Private relay (Flashbots Protect)",
    shortLabel: "Private relay",
    description:
      "Hidden from the public mempool until it lands and not included if it would revert, so a failed send costs no gas. Builders include it when they choose; there is no target block.",
    hint: "Hidden from the public mempool until it lands and not included if it would revert, so a failed send costs no gas.",
    badge: "PRIVATE",
    availableOn: (chain) => chain?.usePrivateMempoolRpc === true,
    sponsorOffNotice:
      "Sponsor gas turned off: private relay sends are paid from your wallet.",
    unavailableNotice: (chainName, fallsBack) =>
      fallsBack
        ? `${chainName} has no private relay, so this step sends to the public mempool.`
        : `${chainName} has no private relay, so this step fails before sending.`,
  },
];

const SEND_MODE_VALUES: ReadonlySet<string> = new Set(
  SEND_MODE_OPTIONS.map((option) => option.value)
);

/**
 * Choices a write action cannot send with yet, and why. Not offered there;
 * a config already saved with one keeps it and the editor says why.
 */
const UNSUPPORTED_SEND_MODES: Readonly<
  Record<string, Partial<Record<SendMode, string>>>
> = {
  "web3/batch-write-contract": {
    "private-relay": `Batch Write Contract can't send through the private relay yet, so this step fails before sending. Set Send as to Normal transaction (sendMode: "transaction"), or split the calls into Write Contract steps to keep them private.`,
  },
};

/** Why `actionType` cannot send as `mode`, or nothing when it can. */
export function unsupportedSendMode(
  actionType: unknown,
  mode: SendMode
): string | undefined {
  return typeof actionType === "string"
    ? UNSUPPORTED_SEND_MODES[actionType]?.[mode]
    : undefined;
}

export const SEND_MODE_KEY = "sendMode";
export const LEGACY_PRIVATE_MEMPOOL_KEY = "usePrivateMempool";

export function isSendMode(value: unknown): value is SendMode {
  return typeof value === "string" && SEND_MODE_VALUES.has(value);
}

/** No `sendMode` set: missing, null or empty. */
function sendModeUnset(value: unknown): boolean {
  return value === undefined || value === null || value === "";
}

/** A `sendMode` that is set but names no mode (wrong case, a typo, a boolean). */
export function unknownSendModeIssue(value: unknown): string | undefined {
  if (sendModeUnset(value) || isSendMode(value)) {
    return;
  }
  const known = SEND_MODE_OPTIONS.map(
    (option) => `"${option.value}" (${option.shortLabel})`
  ).join(" or ");
  return `sendMode must be ${known}, not ${JSON.stringify(value)}.`;
}

/**
 * `usePrivateMempool` as the old runtime read it: any truthy value (the string
 * "false" included) sent through the relay, so saved configs keep sending so.
 */
function readLegacyFlag(value: unknown): boolean | undefined {
  return value === undefined || value === null ? undefined : Boolean(value);
}

type SendModeConfig = { sendMode?: unknown; usePrivateMempool?: unknown };

/** The mode a config sends with: `sendMode`, else the legacy flag, else Normal. */
export function resolveSendMode(config: SendModeConfig): SendMode {
  if (isSendMode(config.sendMode)) {
    return config.sendMode;
  }
  return readLegacyFlag(config.usePrivateMempool) === true
    ? SEND_MODE.PRIVATE_RELAY
    : SEND_MODE.TRANSACTION;
}

/** Saved with the old "(Flashbots)" network entry and not edited since. */
export function isLegacyPrivateRelayConfig(config: SendModeConfig): boolean {
  return (
    sendModeUnset(config.sendMode) &&
    readLegacyFlag(config.usePrivateMempool) === true
  );
}

/** Any stored `usePrivateMempool` with no `sendMode`, kept as saved on import. */
export function hasLegacyFlagOnly(config: SendModeConfig): boolean {
  return (
    sendModeUnset(config.sendMode) && config.usePrivateMempool !== undefined
  );
}

export function sendModeOption(mode: SendMode): SendModeOption {
  return (
    SEND_MODE_OPTIONS.find((option) => option.value === mode) ??
    SEND_MODE_OPTIONS[0]
  );
}

/**
 * How a step asks for the relay at run time: not at all, required (`sendMode`;
 * refused where there is none unless `strict` is false), or only where there is
 * one (the legacy flag alone, which sends publicly elsewhere, as it always did).
 */
type RelayUse = "none" | "required" | "if-available";

export function relayUseOf(config: SendModeConfig): RelayUse {
  if (resolveSendMode(config) !== SEND_MODE.PRIVATE_RELAY) {
    return "none";
  }
  return isLegacyPrivateRelayConfig(config) ? "if-available" : "required";
}

export function availableSendModes(
  chain: SendModeChain | undefined
): SendModeOption[] {
  return SEND_MODE_OPTIONS.filter((option) => option.availableOn(chain));
}

/**
 * The keys the editor writes for a mode; the legacy key is kept in agreement
 * for older executors during a rolling deploy and for API clients that read it.
 */
export function sendModeUpdates(mode: SendMode): [string, unknown][] {
  return [
    [SEND_MODE_KEY, mode],
    [LEGACY_PRIVATE_MEMPOOL_KEY, mode === SEND_MODE.PRIVATE_RELAY],
  ];
}

/**
 * A `sendMode` and a `usePrivateMempool` that say different things. Either is
 * accepted alone; together they must agree.
 */
export function sendModeConflict(config: SendModeConfig): string | undefined {
  const legacy = readLegacyFlag(config.usePrivateMempool);
  if (!isSendMode(config.sendMode) || legacy === undefined) {
    return;
  }
  if (legacy === (config.sendMode === SEND_MODE.PRIVATE_RELAY)) {
    return;
  }
  return `sendMode "${config.sendMode}" and usePrivateMempool ${JSON.stringify(config.usePrivateMempool)} disagree. Send sendMode alone, or pair usePrivateMempool: true with "${SEND_MODE.PRIVATE_RELAY}" and usePrivateMempool: false with "${SEND_MODE.TRANSACTION}".`;
}

/** New values of the legacy key must be booleans; older stored ones are read as before. */
export function legacyFlagTypeIssue(value: unknown): string | undefined {
  if (value === undefined || typeof value === "boolean") {
    return;
  }
  return `usePrivateMempool must be true or false, not ${JSON.stringify(value)}. To choose how the step sends, set sendMode to "${SEND_MODE.TRANSACTION}" or "${SEND_MODE.PRIVATE_RELAY}".`;
}
