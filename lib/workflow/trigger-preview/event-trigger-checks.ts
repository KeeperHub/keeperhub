/**
 * Static diagnosis of an Event trigger's configuration.
 *
 * Deliberately free of database, network and `server-only` imports: these are
 * the checks that need nothing but the config itself and the chain row, so
 * they stay callable from a unit test, from the preview route, and - later -
 * from the editor without a round trip.
 *
 * Every code here mirrors a point where the event pipeline refuses the
 * workflow without telling the user:
 *
 * | Code                      | Refused by                                        |
 * |---------------------------|---------------------------------------------------|
 * | NETWORK_MISSING           | buildRegistration, "no chainId in config.network" |
 * | NETWORK_INVALID           | buildRegistration, "chainId is not numeric"       |
 * | CHAIN_UNKNOWN             | buildRegistration, "references unknown chainId"   |
 * | CHAIN_HAS_NO_WEBSOCKET    | buildRegistration, "has no defaultPrimaryWss"     |
 * | CONTRACT_ADDRESS_MISSING  | buildRegistration, "missing contractAddress"      |
 * | EVENT_NAME_MISSING        | buildRegistration, "missing eventName"            |
 * | ABI_MISSING               | buildRegistration, "missing contractABI"          |
 * | ABI_NOT_JSON              | buildRegistration, "invalid contractABI JSON"     |
 * | ABI_NOT_ARRAY             | buildRegistration, "contractABI is not an array"  |
 * | ABI_HAS_NO_EVENTS         | buildRegistration, "contains no events"           |
 * | EVENT_NOT_IN_ABI          | EventListener.start, "not found in ABI"           |
 *
 * Each of those emits a `logger.warn` inside the event-tracker pod and
 * returns, so the workflow reports Enabled and never runs. That asymmetry is
 * the reason this module exists.
 *
 * The event tracker lives in `keeperhub-events/`, which the root tsconfig
 * excludes, so the rule cannot be imported and is reproduced here instead.
 * `tests/unit/event-trigger-preview.test.ts` pins the list so a refusal added
 * there and not here fails a test rather than going quiet in production.
 */

import { ethers } from "ethers";
import { getChainIdFromNetwork } from "@/lib/rpc/network-utils";
import { hasTemplateVariables } from "@/lib/utils/template";
import type {
  EventTriggerChainFacts,
  EventTriggerConfig,
  EventTriggerPreviewCode,
  EventTriggerPreviewFinding,
} from "./types";

/** Config fields whose value must be literal, because a trigger has no upstream node. */
const LITERAL_ONLY_FIELDS = [
  "network",
  "contractAddress",
  "contractABI",
  "eventName",
] as const;

/** Everything the scan needs, available only when no static check blocked. */
export type EventTriggerTarget = {
  chainId: number;
  contractAddress: string;
  eventName: string;
  topic0: string;
  /** Event fragments from the ABI, used to decode a matching log. */
  eventFragments: ethers.EventFragment[];
  recipientFilter?: string;
  memoFilter?: string;
};

export type EventTriggerStaticResult = {
  findings: EventTriggerPreviewFinding[];
  /** Null when any finding is blocking. */
  target: EventTriggerTarget | null;
};

function blocking(
  code: EventTriggerPreviewCode,
  message: string,
  fieldKey?: string
): EventTriggerPreviewFinding {
  return { code, severity: "blocking", message, fieldKey };
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Resolve `config.network` to a chain ID.
 *
 * Split out because the caller needs the chain ID to load the chain row
 * before the remaining checks can run.
 */
export function resolveTriggerChainId(
  config: EventTriggerConfig
): { chainId: number } | { finding: EventTriggerPreviewFinding } {
  const network = readString(config.network);

  if (network === "") {
    return {
      finding: blocking(
        "NETWORK_MISSING",
        "This trigger has no network selected, so it is never registered with the event tracker.",
        "network"
      ),
    };
  }

  try {
    return { chainId: getChainIdFromNetwork(network) };
  } catch {
    return {
      finding: blocking(
        "NETWORK_INVALID",
        `"${network}" is not a chain ID or a known network name.`,
        "network"
      ),
    };
  }
}

function checkTemplates(
  config: EventTriggerConfig
): EventTriggerPreviewFinding[] {
  const templated = LITERAL_ONLY_FIELDS.filter((field) =>
    hasTemplateVariables(readString(config[field]))
  );

  if (templated.length === 0) {
    return [];
  }

  return [
    blocking(
      "CONFIG_HAS_TEMPLATE",
      `${templated.join(", ")} contains a template reference. A trigger runs before any other node, so there is no output to resolve it from and the value is used literally.`,
      templated[0]
    ),
  ];
}

function checkChain(
  chainId: number,
  chain: EventTriggerChainFacts | null
): EventTriggerPreviewFinding[] {
  if (!chain) {
    return [
      blocking(
        "CHAIN_UNKNOWN",
        `Chain ${chainId} is not in the chains table, so the event tracker skips this workflow.`,
        "network"
      ),
    ];
  }

  if (chain.isEnabled === false) {
    return [
      blocking(
        "CHAIN_DISABLED",
        `${chain.name} is disabled, so no workflow on it is registered.`,
        "network"
      ),
    ];
  }

  if (chain.chainType !== "evm") {
    return [
      blocking(
        "CHAIN_NOT_EVM",
        `${chain.name} is a ${chain.chainType} chain. Preview covers EVM contract events only.`,
        "network"
      ),
    ];
  }

  const wss = chain.defaultPrimaryWss ?? "";
  if (!(wss.startsWith("wss://") || wss.startsWith("ws://"))) {
    return [
      blocking(
        "CHAIN_HAS_NO_WEBSOCKET",
        `${chain.name} has no WebSocket endpoint configured. Event triggers subscribe over WebSocket, so no event trigger on this chain can fire.`,
        "network"
      ),
    ];
  }

  return [];
}

function checkContractAddress(
  config: EventTriggerConfig
): EventTriggerPreviewFinding[] {
  const address = readString(config.contractAddress);

  if (address === "") {
    return [
      blocking(
        "CONTRACT_ADDRESS_MISSING",
        "This trigger has no contract address.",
        "contractAddress"
      ),
    ];
  }

  if (!ethers.isAddress(address)) {
    return [
      blocking(
        "CONTRACT_ADDRESS_INVALID",
        `"${address}" is not a valid EVM address.`,
        "contractAddress"
      ),
    ];
  }

  return [];
}

type AbiEventsResult =
  | { fragments: ethers.EventFragment[] }
  | { finding: EventTriggerPreviewFinding };

/**
 * Event fragments the ABI declares, skipping entries ethers cannot parse.
 *
 * A single malformed entry is skipped rather than failing the whole ABI: the
 * tracker's own filter is `entry?.type === "event"`, so an ABI carrying one
 * bad fragment alongside the wanted one still registers there.
 */
function collectEventFragments(entries: unknown[]): ethers.EventFragment[] {
  const fragments: ethers.EventFragment[] = [];

  for (const entry of entries) {
    if (
      typeof entry !== "object" ||
      entry === null ||
      (entry as { type?: unknown }).type !== "event"
    ) {
      continue;
    }
    try {
      fragments.push(ethers.EventFragment.from(entry));
    } catch {
      // Unparseable fragment. Skipped rather than fatal; if it was the
      // selected event, selectEvent reports EVENT_NOT_IN_ABI.
    }
  }

  return fragments;
}

function parseAbiEvents(config: EventTriggerConfig): AbiEventsResult {
  const raw = readString(config.contractABI);

  if (raw === "") {
    return {
      finding: blocking(
        "ABI_MISSING",
        "This trigger has no contract ABI, so its event cannot be decoded.",
        "contractABI"
      ),
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      finding: blocking(
        "ABI_NOT_JSON",
        "The contract ABI is not valid JSON.",
        "contractABI"
      ),
    };
  }

  if (!Array.isArray(parsed)) {
    return {
      finding: blocking(
        "ABI_NOT_ARRAY",
        "The contract ABI must be a JSON array of fragments.",
        "contractABI"
      ),
    };
  }

  const fragments = collectEventFragments(parsed);

  if (fragments.length === 0) {
    return {
      finding: blocking(
        "ABI_HAS_NO_EVENTS",
        "The contract ABI contains no event fragments. This is usually the wrong ABI rather than a missing event.",
        "contractABI"
      ),
    };
  }

  return { fragments };
}

type EventSelectionResult =
  | { fragment: ethers.EventFragment }
  | { finding: EventTriggerPreviewFinding };

function selectEvent(
  config: EventTriggerConfig,
  fragments: ethers.EventFragment[]
): EventSelectionResult {
  const eventName = readString(config.eventName);

  if (eventName === "") {
    return {
      finding: blocking(
        "EVENT_NAME_MISSING",
        "This trigger has no event selected.",
        "eventName"
      ),
    };
  }

  const matching = fragments.filter((fragment) => fragment.name === eventName);

  if (matching.length === 0) {
    const available = fragments.map((fragment) => fragment.name).join(", ");
    return {
      finding: blocking(
        "EVENT_NOT_IN_ABI",
        `The ABI has no event named "${eventName}". Available events: ${available}.`,
        "eventName"
      ),
    };
  }

  if (matching.length > 1) {
    return {
      finding: blocking(
        "EVENT_NAME_AMBIGUOUS",
        `The ABI declares ${matching.length} events named "${eventName}". The listener resolves the event by name and cannot choose between overloads.`,
        "eventName"
      ),
    };
  }

  return { fragment: matching[0] };
}

/**
 * Run every check that needs no network access.
 *
 * Findings are collected rather than short-circuited so one pass reports
 * everything that is wrong, except where a later check genuinely depends on
 * an earlier one: the event name cannot be looked up in an ABI that did not
 * parse.
 */
export function runEventTriggerStaticChecks(params: {
  config: EventTriggerConfig;
  chainId: number;
  chain: EventTriggerChainFacts | null;
}): EventTriggerStaticResult {
  const { config, chainId, chain } = params;

  const findings: EventTriggerPreviewFinding[] = [
    ...checkTemplates(config),
    ...checkChain(chainId, chain),
    ...checkContractAddress(config),
  ];

  const abi = parseAbiEvents(config);
  if ("finding" in abi) {
    return { findings: [...findings, abi.finding], target: null };
  }

  const selected = selectEvent(config, abi.fragments);
  if ("finding" in selected) {
    return { findings: [...findings, selected.finding], target: null };
  }

  if (findings.length > 0) {
    return { findings, target: null };
  }

  return {
    findings,
    target: {
      chainId,
      contractAddress: readString(config.contractAddress),
      eventName: selected.fragment.name,
      topic0: selected.fragment.topicHash,
      eventFragments: abi.fragments,
      recipientFilter: readString(config.recipientAddress) || undefined,
      memoFilter: readString(config.memo) || undefined,
    },
  };
}
