/**
 * Shared types for trigger preview: an advisory, read-only answer to
 * "will this trigger ever fire, and how often?" asked before a workflow is
 * enabled.
 *
 * Every finding is advisory. Nothing here blocks enabling or running a
 * workflow, for the same reason `runWorkflowSimulation` only ever warns:
 * the preview reads current chain state and a bounded slice of history, and
 * neither is a proof about the future.
 */

/**
 * Why a preview reached its verdict.
 *
 * The `TRIGGER_*`, `NETWORK_*`, `CHAIN_*`, `CONTRACT_*`, `ABI_*` and `EVENT_*`
 * codes each correspond to a point where the event tracker refuses a
 * registration or a listener fails to start. See
 * `eventTriggerStaticFindings` for the mapping.
 */
export type EventTriggerPreviewCode =
  // Static: workflow shape
  | "TRIGGER_NODE_MISSING"
  | "TRIGGER_TYPE_NOT_EVENT"
  // Static: network
  | "NETWORK_MISSING"
  | "NETWORK_INVALID"
  | "CHAIN_UNKNOWN"
  | "CHAIN_DISABLED"
  | "CHAIN_NOT_EVM"
  | "CHAIN_HAS_NO_WEBSOCKET"
  // Static: contract
  | "CONTRACT_ADDRESS_MISSING"
  | "CONTRACT_ADDRESS_INVALID"
  | "CONFIG_HAS_TEMPLATE"
  // Static: ABI
  | "ABI_MISSING"
  | "ABI_NOT_JSON"
  | "ABI_NOT_ARRAY"
  | "ABI_HAS_NO_EVENTS"
  // Static: event selection
  | "EVENT_NAME_MISSING"
  | "EVENT_NOT_IN_ABI"
  | "EVENT_NAME_AMBIGUOUS"
  // Live
  | "CONTRACT_HAS_NO_CODE"
  | "NO_MATCHES_CONTRACT_ACTIVE"
  | "NO_MATCHES_CONTRACT_SILENT"
  | "FILTERS_EXCLUDED_EVERY_MATCH"
  | "HIGH_VOLUME"
  | "SCAN_TRUNCATED"
  | "SCAN_UNAVAILABLE";

/** How severely a finding bears on whether the trigger will fire. */
export type EventTriggerPreviewSeverity =
  /** A fact that guarantees the trigger cannot dispatch as configured. */
  | "blocking"
  /** Worth acting on, but the trigger can still fire. */
  | "warning"
  /** Context for reading the result. */
  | "info";

export type EventTriggerPreviewFinding = {
  code: EventTriggerPreviewCode;
  severity: EventTriggerPreviewSeverity;
  message: string;
  /**
   * The trigger config field the finding is about, so the editor can point at
   * the input rather than making the reader find it. Absent when the finding
   * is about the chain or the contract rather than about a configured field.
   */
  fieldKey?: string;
};

export type EventTriggerPreviewMatch = {
  blockNumber: number;
  transactionHash: string;
  logIndex: number;
  /** Decoded event arguments, with every bigint rendered as a string. */
  args: Record<string, unknown>;
};

export type EventTriggerPreviewScan = {
  fromBlock: number;
  toBlock: number;
  blocksScanned: number;
  /**
   * Wall-clock seconds the scanned range covers, from the two block
   * timestamps. Null when either timestamp could not be read, which is the
   * only thing that makes `estimatedFiresPerDay` null on an otherwise
   * successful scan.
   */
  spanSeconds: number | null;
};

/**
 * `will-never-fire` is claimed only from a blocking finding - a static
 * refusal the tracker would make, or an address with no contract code. An
 * empty result window is `no-recent-matches`, never `will-never-fire`: a rare
 * event is indistinguishable from a broken one by absence alone.
 *
 * `unknown` is the verdict when the configuration is sound but the scan could
 * not run, so nothing is claimed about firing behaviour either way.
 */
export type EventTriggerPreviewVerdict =
  | "will-never-fire"
  | "unknown"
  | "no-recent-matches"
  | "high-volume"
  | "ok";

export type EventTriggerPreviewResult = {
  verdict: EventTriggerPreviewVerdict;
  /** One sentence, safe to render verbatim. */
  summary: string;
  findings: EventTriggerPreviewFinding[];
  /** Null when no scan ran, either because a static check blocked it or the RPC was unavailable. */
  scan: EventTriggerPreviewScan | null;
  /** Logs that matched topic0, decoded to this event, and passed every configured filter. */
  matchCount: number | null;
  /** Logs that matched topic0 but were dropped by a recipient or memo filter. */
  filteredOutCount: number | null;
  /** Extrapolated from `matchCount` over `scan.spanSeconds`. Null when either is unknown. */
  estimatedFiresPerDay: number | null;
  /** Most recent matches first, bounded by `MAX_PREVIEW_SAMPLES`. */
  samples: EventTriggerPreviewMatch[];
};

/** The Event-trigger config fields the preview reads. */
export type EventTriggerConfig = {
  triggerType?: unknown;
  network?: unknown;
  contractAddress?: unknown;
  contractABI?: unknown;
  eventName?: unknown;
  /** Post-decode filter carried by the payment trigger. */
  recipientAddress?: unknown;
  /** Post-decode filter carried by the payment trigger. */
  memo?: unknown;
};

/** The chain facts the preview needs, as stored in the `chains` table. */
export type EventTriggerChainFacts = {
  name: string;
  chainType: string;
  isEnabled: boolean | null;
  defaultPrimaryWss: string | null;
};
