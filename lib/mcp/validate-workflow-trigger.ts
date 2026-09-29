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
 * network, no MCP SDK. The two conditions that need facts from outside the
 * workflow, the chain's WebSocket endpoint and the address a protocol event
 * resolves to, are passed in by the route the same way `chainIds` is, and are
 * skipped entirely when the caller does not supply them.
 *
 * Scope, stated rather than implied:
 *
 *   - Solana Event triggers are skipped. They store `programId` and `idl`
 *     rather than `contractAddress` and `contractABI`, and register through
 *     `keeperhub-events/solana-tracker`, not `buildRegistration`.
 *   - The Transfer trigger (`WorkflowTriggerEnum.TEMPO_PAYMENT`) is not
 *     checked. The events route admits it and sends it through the same
 *     `buildRegistration`, injecting its ABI and eventName, so a Transfer
 *     trigger on a chain with no WebSocket endpoint is the same silent
 *     failure. It is left out of this change rather than covered implicitly.
 *
 * The tracker cannot be imported from here (`keeperhub-events/` is a separate
 * workspace, excluded from the root tsconfig), so its rule is reproduced. It
 * is pinned by a differential test that imports `buildRegistration` directly
 * and asserts the two agree on the same fixtures, rather than by a list of
 * codes someone has to remember to update.
 */

import { ethers } from "ethers";
import {
  VALIDATION_ERROR_CODES,
  type ValidationErrorCode,
} from "@/lib/mcp/validate-workflow-codes";
import { isSolanaChain } from "@/lib/rpc/solana-chains";
import { WorkflowTriggerEnum } from "@/lib/workflow/store";

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

/**
 * Chain facts this module needs, keyed by chain id.
 *
 * The value is the chain's `default_primary_wss`, which is nullable in the
 * schema. Omitting the map skips the WebSocket check rather than reporting
 * every trigger as unregisterable.
 */
export type ChainWebsockets = ReadonlyMap<number, string | null>;

/**
 * Resolves the contract address a protocol event points at on a chain, the
 * way `app/api/workflows/events/route.ts` does before the tracker sees the
 * node. Returns null when it does not resolve. See
 * `lib/workflow/protocol-event-address.ts`.
 */
export type ProtocolEventAddressResolver = (
  protocolSlug: string | undefined,
  eventSlug: string | undefined,
  network: string | undefined
) => string | null;

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
    if (readStringConfig(node, "triggerType") === WorkflowTriggerEnum.EVENT) {
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
 *
 * The route's resolution is what counts, not its inputs: the slugs can be
 * present while the protocol is not deployed on the trigger's chain, and then
 * the address stays empty and the tracker refuses. So the check asks the same
 * resolver the route uses, and only skips when the caller supplies none.
 */
function checkContractAddress(
  node: NodeLike,
  index: number,
  resolveProtocolEventAddress: ProtocolEventAddressResolver | undefined
): TriggerIssue[] {
  const address = readStringConfig(node, "contractAddress");
  if (address !== null && address !== "") {
    return [];
  }

  // Truthiness, not null checks: the route gates on `protocolSlug &&
  // eventSlug && network`, so an empty slug is absent there too.
  const protocolSlug = readStringConfig(node, "_eventProtocolSlug") || null;
  const eventSlug = readStringConfig(node, "_eventSlug") || null;
  const fromProtocolEvent = protocolSlug !== null && eventSlug !== null;

  if (fromProtocolEvent) {
    if (resolveProtocolEventAddress === undefined) {
      return [];
    }
    const network = readStringConfig(node, "network") || undefined;
    if (resolveProtocolEventAddress(protocolSlug, eventSlug, network)) {
      return [];
    }
    return [
      issue(
        VALIDATION_ERROR_CODES.TRIGGER_MISSING_CONTRACT_ADDRESS,
        `Event trigger has no contractAddress, and protocol event "${protocolSlug}/${eventSlug}" has no contract address on network ${network ?? "(none)"}, so the event tracker skips this workflow and it never runs.`,
        `nodes[${index}].config.contractAddress`
      ),
    ];
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

  // A null entry inside inputs throws on destructuring in buildEventAbi, the
  // same as a missing array.
  const broken = events.filter(
    (entry) =>
      !Array.isArray(entry.inputs) ||
      entry.inputs.some(
        (input: unknown) => input === null || input === undefined
      )
  );
  if (broken.length > 0) {
    const named = broken
      .map((entry) => (typeof entry.name === "string" ? entry.name : "unnamed"))
      .join(", ");
    return [
      issue(
        VALIDATION_ERROR_CODES.TRIGGER_ABI_EVENT_MISSING_INPUTS,
        `Event fragment ${named} in contractABI has no usable inputs array. The event tracker serialises every event in the ABI and throws on this one, dropping the whole workflow.`,
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

  const iface = eventInterface(events);
  let fragment: ethers.EventFragment | null;
  try {
    fragment = iface.getEvent(eventName);
  } catch (error) {
    // getEvent throws, rather than returning null, on a bare name that
    // matches more than one overload and on a malformed signature. Either
    // way EventListener.start throws and the workflow never runs.
    if (error instanceof Error && error.message.includes("ambiguous")) {
      return [
        issue(
          VALIDATION_ERROR_CODES.TRIGGER_EVENT_NAME_AMBIGUOUS,
          `contractABI declares more than one event named "${eventName}". Use the full signature, for example "${eventName}(address,uint256)", so the event tracker can tell them apart.`,
          `nodes[${index}].config.eventName`
        ),
      ];
    }
    fragment = null;
  }

  if (fragment === null) {
    const available: string[] = [];
    iface.forEachEvent((entry) => {
      available.push(entry.format("sighash"));
    });
    return [
      issue(
        VALIDATION_ERROR_CODES.TRIGGER_EVENT_NOT_IN_ABI,
        `contractABI has no event matching "${eventName}". Available events: ${available.join(", ") || "(none)"}.`,
        `nodes[${index}].config.eventName`
      ),
    ];
  }

  return [];
}

/**
 * The string `buildEventAbi` (`keeperhub-events/event-tracker/src/chains/
 * event-serializer.ts`) produces for one fragment, reproduced exactly.
 */
function buildEventAbi(entry: AbiEntryLike): string {
  const inputs = entry.inputs as Array<{
    name?: unknown;
    type?: unknown;
    indexed?: unknown;
  }>;
  const parsedInputs = inputs
    .map(
      ({ name, type, indexed }) => `${type} ${indexed ? "indexed " : ""}${name}`
    )
    .join(", ");
  return `event ${entry.name}(${parsedInputs})`;
}

/**
 * The interface the tracker's listener resolves `eventName` against.
 *
 * `new ethers.Interface(strings)` skips a string it cannot parse, such as
 * `event Filled(tuple order)` (buildEventAbi drops tuple components), after
 * printing a console warning. Parsing each fragment here and dropping the
 * failures gives the same interface without the warning.
 */
function eventInterface(events: AbiEntryLike[]): ethers.Interface {
  const fragments: ethers.EventFragment[] = [];
  for (const entry of events) {
    try {
      fragments.push(ethers.EventFragment.from(buildEventAbi(entry)));
    } catch {
      // Absent from the tracker's interface too.
    }
  }
  return new ethers.Interface(fragments);
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
  chainWebsockets?: ChainWebsockets,
  resolveProtocolEventAddress?: ProtocolEventAddressResolver
): TriggerIssue[] {
  const found = findEventTrigger(nodes);
  if (found === null) {
    return [];
  }

  const { node, index } = found;
  const chainId = resolveChainId(node);
  if (chainId !== null && isSolanaChain(chainId)) {
    return [];
  }
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
  issues.push(
    ...checkContractAddress(node, index, resolveProtocolEventAddress)
  );

  const abi = parseAbi(node, index);
  if ("issues" in abi) {
    issues.push(...abi.issues);
    return issues;
  }

  issues.push(...checkEventFragments(node, index, abi.events));
  return issues;
}
