/**
 * Event-trigger registration checks.
 *
 * An Event trigger that the event tracker declines to register produces no
 * error anywhere the user can see. `buildRegistration`
 * (`keeperhub-events/event-tracker/src/listener/workflow-mapper.ts`) returns
 * null at thirteen points and `buildEventAbi` throws at a fourteenth; each one
 * writes a `logger.warn` inside the tracker pod and the workflow goes on
 * reporting Enabled while never running. That is indistinguishable from a
 * correctly configured trigger waiting on a rare event.
 *
 * Two of those conditions are already reported by `chainExists` in
 * validate-workflow-web3.ts (a non-numeric chain id, and one absent from the
 * chains table). This module covers the rest.
 *
 * Pure, in the same sense as the rest of this validator: no database, no
 * network, no MCP SDK. The one condition that needs a database fact, the
 * chain's WebSocket endpoint, is passed in by the route the same way
 * `chainIds` is, and is skipped entirely when the caller does not supply it.
 *
 * The tracker cannot be imported from here (`keeperhub-events/` is a separate
 * workspace, excluded from the root tsconfig), so its rule is reproduced. It
 * is pinned by a differential test that imports `buildRegistration` directly
 * and asserts the two agree on the same fixtures, rather than by a list of
 * codes someone has to remember to update.
 */

import {
  VALIDATION_ERROR_CODES,
  type ValidationErrorCode,
} from "@/lib/mcp/validate-workflow-codes";

type TriggerIssue = {
  code: ValidationErrorCode;
  message: string;
  parameterPath: string;
};

type NodeLike = {
  id?: unknown;
  data?: {
    type?: unknown;
    config?: Record<string, unknown>;
  } | null;
};

/** The trigger type the event tracker registers as a contract-log subscription. */
const EVENT_TRIGGER_TYPE = "Event";

/**
 * Chain facts this module needs, keyed by chain id.
 *
 * The value is the chain's `default_primary_wss`, which is nullable in the
 * schema. Omitting the map skips the WebSocket check rather than reporting
 * every trigger as unregisterable.
 */
export type ChainWebsockets = ReadonlyMap<number, string | null>;

function issue(
  code: ValidationErrorCode,
  message: string,
  parameterPath: string
): TriggerIssue {
  return { code, message, parameterPath };
}

function readStringConfig(node: NodeLike, key: string): string | null {
  const config = node?.data?.config;
  if (config === undefined || config === null) {
    return null;
  }
  const value = config[key];
  return typeof value === "string" ? value : null;
}

function findEventTrigger(
  nodes: unknown
): { node: NodeLike; index: number } | null {
  if (!Array.isArray(nodes)) {
    return null;
  }
  for (const [index, rawNode] of nodes.entries()) {
    const node = rawNode as NodeLike;
    if (node?.data?.type !== "trigger") {
      continue;
    }
    if (readStringConfig(node, "triggerType") === EVENT_TRIGGER_TYPE) {
      return { node, index };
    }
    // Only one trigger node exists per workflow, so a trigger of another type
    // means there is no Event trigger to check.
    return null;
  }
  return null;
}

/**
 * The tracker reads `Number(config.network)` and rejects a non-finite result.
 * Deliberately not `getChainIdFromNetwork`, which maps legacy names such as
 * "ethereum" to ids: the tracker does no such mapping, so a trigger naming a
 * chain that way is refused there and must not validate clean here.
 */
function resolveChainId(node: NodeLike): number | null {
  const raw = readStringConfig(node, "network");
  if (raw === null || raw === "") {
    return null;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function checkWebsocket(
  node: NodeLike,
  index: number,
  chainWebsockets: ChainWebsockets
): TriggerIssue[] {
  const chainId = resolveChainId(node);
  // A chain id this module cannot resolve is already reported by chainExists.
  if (chainId === null || !chainWebsockets.has(chainId)) {
    return [];
  }

  const wss = chainWebsockets.get(chainId) ?? "";
  if (wss.startsWith("wss://") || wss.startsWith("ws://")) {
    return [];
  }

  return [
    issue(
      VALIDATION_ERROR_CODES.TRIGGER_CHAIN_HAS_NO_WEBSOCKET,
      `Chain ${chainId} has no WebSocket endpoint configured. Event triggers subscribe to contract logs over WebSocket, so no Event trigger on this chain is ever registered.`,
      `nodes[${index}].config.network`
    ),
  ];
}

/**
 * A missing contract address is not always missing.
 *
 * `app/api/workflows/events/route.ts` resolves one from `_eventProtocolSlug`
 * and `_eventSlug` before the tracker ever sees the node, which is how the
 * Hub's "create a workflow from a protocol event" path builds a trigger. The
 * address genuinely is absent from the config there, and reporting it would be
 * a false error on a first-class creation path.
 */
function checkContractAddress(node: NodeLike, index: number): TriggerIssue[] {
  const address = readStringConfig(node, "contractAddress");
  if (address !== null && address !== "") {
    return [];
  }

  const protocolSlug = readStringConfig(node, "_eventProtocolSlug");
  const eventSlug = readStringConfig(node, "_eventSlug");
  if (protocolSlug !== null && eventSlug !== null) {
    return [];
  }

  return [
    issue(
      VALIDATION_ERROR_CODES.TRIGGER_MISSING_CONTRACT_ADDRESS,
      "Event trigger has no contractAddress, so the event tracker skips this workflow and it never runs.",
      `nodes[${index}].config.contractAddress`
    ),
  ];
}

type AbiEntryLike = { type?: unknown; name?: unknown; inputs?: unknown };

type AbiParseOutcome = { events: AbiEntryLike[] } | { issues: TriggerIssue[] };

function parseAbi(node: NodeLike, index: number): AbiParseOutcome {
  const path = `nodes[${index}].config.contractABI`;
  const raw = readStringConfig(node, "contractABI");

  if (raw === null || raw === "") {
    return {
      issues: [
        issue(
          VALIDATION_ERROR_CODES.TRIGGER_MISSING_ABI,
          "Event trigger has no contractABI, so the event tracker skips this workflow and it never runs.",
          path
        ),
      ],
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      issues: [
        issue(
          VALIDATION_ERROR_CODES.TRIGGER_ABI_NOT_JSON,
          "Event trigger contractABI is not valid JSON, so the event tracker skips this workflow.",
          path
        ),
      ],
    };
  }

  if (!Array.isArray(parsed)) {
    return {
      issues: [
        issue(
          VALIDATION_ERROR_CODES.TRIGGER_ABI_NOT_ARRAY,
          "Event trigger contractABI is not a JSON array, so the event tracker skips this workflow.",
          path
        ),
      ],
    };
  }

  const events = (parsed as AbiEntryLike[]).filter(
    (entry) => entry?.type === "event"
  );

  if (events.length === 0) {
    return {
      issues: [
        issue(
          VALIDATION_ERROR_CODES.TRIGGER_ABI_HAS_NO_EVENTS,
          "Event trigger contractABI contains no event fragments. This is usually the wrong ABI rather than a missing event.",
          path
        ),
      ],
    };
  }

  return { events };
}

/**
 * Every event fragment has to carry `inputs`, not just the selected one.
 *
 * The tracker maps `buildEventAbi` over all of them, and that function reads
 * `inputs.map(...)` with no guard, so one fragment shaped
 * `{type: "event", name: "X"}` throws a TypeError that is caught and logged
 * where no user sees it. The whole workflow is dropped, including the event
 * the trigger actually wanted.
 */
function checkEventFragments(
  node: NodeLike,
  index: number,
  events: AbiEntryLike[]
): TriggerIssue[] {
  const path = `nodes[${index}].config.contractABI`;

  const broken = events.filter((entry) => !Array.isArray(entry.inputs));
  if (broken.length > 0) {
    const named = broken
      .map((entry) => (typeof entry.name === "string" ? entry.name : "unnamed"))
      .join(", ");
    return [
      issue(
        VALIDATION_ERROR_CODES.TRIGGER_ABI_EVENT_MISSING_INPUTS,
        `Event fragment ${named} in contractABI has no inputs array. The event tracker serialises every event in the ABI and throws on this one, dropping the whole workflow.`,
        path
      ),
    ];
  }

  const eventName = readStringConfig(node, "eventName");
  if (eventName === null || eventName === "") {
    return [
      issue(
        VALIDATION_ERROR_CODES.TRIGGER_MISSING_EVENT_NAME,
        "Event trigger has no eventName, so the event tracker skips this workflow and it never runs.",
        `nodes[${index}].config.eventName`
      ),
    ];
  }

  const available = events
    .map((entry) => (typeof entry.name === "string" ? entry.name : null))
    .filter((name): name is string => name !== null);

  if (!available.includes(eventName)) {
    return [
      issue(
        VALIDATION_ERROR_CODES.TRIGGER_EVENT_NOT_IN_ABI,
        `contractABI has no event named "${eventName}". Available events: ${available.join(", ") || "(none)"}.`,
        `nodes[${index}].config.eventName`
      ),
    ];
  }

  return [];
}

/**
 * Report the conditions under which an Event trigger is silently never
 * registered.
 *
 * Checks run in the tracker's own order and stop at the first ABI failure,
 * because each later one reads what the earlier one produced. The
 * connection-level checks above it are independent and all run.
 */
export function eventTriggerRegistration(
  nodes: unknown,
  chainWebsockets?: ChainWebsockets
): TriggerIssue[] {
  const found = findEventTrigger(nodes);
  if (found === null) {
    return [];
  }

  const { node, index } = found;
  const issues: TriggerIssue[] = [];

  // chainExists skips a node with no `network` at all, which is right for an
  // action that does not need one. A trigger does: the tracker reads
  // `config.network` and refuses the workflow when it is not a string.
  const network = readStringConfig(node, "network");
  if (network === null || network === "") {
    issues.push(
      issue(
        VALIDATION_ERROR_CODES.TRIGGER_MISSING_NETWORK,
        "Event trigger has no network, so the event tracker skips this workflow and it never runs.",
        `nodes[${index}].config.network`
      )
    );
  }

  if (chainWebsockets !== undefined) {
    issues.push(...checkWebsocket(node, index, chainWebsockets));
  }
  issues.push(...checkContractAddress(node, index));

  const abi = parseAbi(node, index);
  if ("issues" in abi) {
    issues.push(...abi.issues);
    return issues;
  }

  issues.push(...checkEventFragments(node, index, abi.events));
  return issues;
}
