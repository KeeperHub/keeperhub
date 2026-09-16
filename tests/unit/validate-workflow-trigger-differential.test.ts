/**
 * Differential test: the validator against the real event tracker.
 *
 * The registration rule lives in `keeperhub-events/`, a separate workspace the
 * root tsconfig excludes, so `validate-workflow-trigger.ts` reproduces it. A
 * reproduction drifts, and a hand-maintained list of codes cannot catch that:
 * it pins the validator against itself and stays green while the two
 * implementations disagree.
 *
 * So this imports `buildRegistration` directly and asserts the two agree on
 * the same fixtures. If the tracker grows a refusal the validator does not
 * know about, the fixture for it fails here.
 *
 * Scope, stated rather than implied:
 *
 *   - Fixtures are Event triggers carrying a config, because that is what
 *     `app/api/workflows/events/route.ts` forwards to the tracker. A trigger
 *     of another type, or one with no config at all, is filtered out before
 *     `buildRegistration` ever sees it.
 *   - The networks map is built from the same chain set the validator is
 *     given. The tracker's real map applies no `isEnabled` filter while
 *     `/validate` selects only enabled chains, which is a pre-existing
 *     divergence in the existing chain check and not this module's to settle.
 *   - `trigger-event-not-in-abi` is excluded and covered in the unit file
 *     instead. `buildRegistration` accepts an eventName the ABI does not
 *     declare; the failure happens later, when `EventListener.start` throws.
 *     It is the same silent class but not the same function.
 */

import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  type ValidatorWorkflow,
  validateWorkflow,
} from "@/lib/mcp/validate-workflow";
import type {
  NetworksMap,
  RawWorkflow,
} from "../../keeperhub-events/event-tracker/lib/types";

/**
 * The tracker is loaded through a non-literal specifier on purpose.
 *
 * A static import would pull `keeperhub-events/` into the root TypeScript
 * program, and that package targets ES2020 while the root targets ES2017, so
 * its BigInt literals fail `pnpm type-check` for reasons that have nothing to
 * do with this test. The types above are imported statically because
 * `lib/types.ts` is plain interfaces and compiles cleanly either way.
 */
const TRACKER_MAPPER =
  "../../keeperhub-events/event-tracker/src/listener/workflow-mapper";

type BuildRegistration = (
  workflow: RawWorkflow,
  networks: NetworksMap
) => unknown;

let buildRegistration: BuildRegistration;

beforeAll(async () => {
  const mod = (await import(/* @vite-ignore */ TRACKER_MAPPER)) as {
    buildRegistration: BuildRegistration;
  };
  buildRegistration = mod.buildRegistration;
});

const CONTRACT = "0x6B175474E89094C44Da98b954EedeAC495271d0F";
const CHAIN_ID = 1;
const WSS = "wss://mainnet.example/ws";

const TRANSFER_EVENT = {
  type: "event",
  name: "Transfer",
  inputs: [
    { name: "from", type: "address", indexed: true },
    { name: "to", type: "address", indexed: true },
    { name: "value", type: "uint256", indexed: false },
  ],
  anonymous: false,
};

const VALID_CONFIG: Record<string, unknown> = {
  triggerType: "Event",
  network: String(CHAIN_ID),
  contractAddress: CONTRACT,
  contractABI: JSON.stringify([TRANSFER_EVENT]),
  eventName: "Transfer",
};

function networksMap(wss: string | null): NetworksMap {
  return {
    [CHAIN_ID]: {
      id: "chain-1",
      chainId: CHAIN_ID,
      name: "Ethereum Mainnet",
      symbol: "ETH",
      chainType: "evm",
      defaultPrimaryRpc: "https://mainnet.example",
      defaultFallbackRpc: "https://mainnet-fallback.example",
      // The column is nullable in the schema even though NetworkConfig types
      // it as string; that mismatch is the reason the tracker guards it.
      defaultPrimaryWss: wss as string,
      defaultFallbackWss: "",
      isTestnet: false,
      isEnabled: true,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    },
  };
}

function triggerNode(config: Record<string, unknown>) {
  return {
    id: "trigger-1",
    type: "trigger",
    data: { label: "Event", type: "trigger", config },
  };
}

/** Does the tracker refuse this workflow? A throw counts as a refusal. */
function trackerRefuses(
  config: Record<string, unknown>,
  wss: string | null
): boolean {
  const raw: RawWorkflow = {
    id: "wf-1",
    name: "Event workflow",
    userId: "user-1",
    organizationId: "org-1",
    enabled: true,
    nodes: [triggerNode(config)] as RawWorkflow["nodes"],
  };
  try {
    return buildRegistration(raw, networksMap(wss)) === null;
  } catch {
    // buildEventAbi throws on an event fragment with no inputs. main.ts
    // catches it and drops the workflow, so it is a refusal.
    return true;
  }
}

/** Does the validator report at least one error for this workflow? */
function validatorRejects(
  config: Record<string, unknown>,
  wss: string | null,
  chainIds: Set<number>
): boolean {
  const workflow: ValidatorWorkflow = {
    id: "wf-1",
    nodes: [triggerNode(config)],
    edges: [],
    inputSchema: { type: "object" },
    outputMapping: null,
    isListed: false,
    workflowType: "read",
  };
  const result = validateWorkflow(workflow, {
    chainIds,
    chainWebsockets: new Map([[CHAIN_ID, wss]]),
  });
  return result.errors.length > 0;
}

type Fixture = {
  label: string;
  config: Record<string, unknown>;
  wss?: string | null;
  /** Chain ids the validator is told about. Defaults to the one chain. */
  chainIds?: Set<number>;
};

const FIXTURES: Fixture[] = [
  { label: "fully configured", config: VALID_CONFIG },
  {
    label: "no network",
    config: { ...VALID_CONFIG, network: undefined },
  },
  {
    label: "legacy chain name instead of an id",
    config: { ...VALID_CONFIG, network: "ethereum" },
  },
  {
    label: "chain absent from the chains table",
    config: { ...VALID_CONFIG, network: "424242" },
    chainIds: new Set([CHAIN_ID]),
  },
  { label: "chain has no WebSocket endpoint", config: VALID_CONFIG, wss: null },
  {
    label: "WebSocket column holds an http URL",
    config: VALID_CONFIG,
    wss: "https://mainnet.example",
  },
  {
    label: "no contract address",
    config: { ...VALID_CONFIG, contractAddress: undefined },
  },
  {
    label: "no event name",
    config: { ...VALID_CONFIG, eventName: undefined },
  },
  {
    label: "no ABI",
    config: { ...VALID_CONFIG, contractABI: undefined },
  },
  {
    label: "ABI is not JSON",
    config: { ...VALID_CONFIG, contractABI: "{not json" },
  },
  {
    label: "ABI is not an array",
    config: {
      ...VALID_CONFIG,
      contractABI: JSON.stringify({ type: "event", name: "Transfer" }),
    },
  },
  {
    label: "ABI carries no event fragments",
    config: {
      ...VALID_CONFIG,
      contractABI: JSON.stringify([{ type: "function", name: "transfer" }]),
    },
  },
  {
    label: "an event fragment has no inputs array",
    config: {
      ...VALID_CONFIG,
      contractABI: JSON.stringify([
        TRANSFER_EVENT,
        { type: "event", name: "Broken" },
      ]),
    },
  },
];

describe("validator agrees with the event tracker on registration", () => {
  it.each(FIXTURES)("$label", ({ config, wss, chainIds }) => {
    const websocket = wss === undefined ? WSS : wss;
    const ids = chainIds ?? new Set([CHAIN_ID]);

    const refused = trackerRefuses(config, websocket);
    const rejected = validatorRejects(config, websocket, ids);

    expect(
      rejected,
      refused
        ? "the tracker refuses this workflow and the validator reports nothing"
        : "the tracker registers this workflow and the validator reports an error"
    ).toBe(refused);
  });

  it("registers the valid fixture rather than vacuously agreeing", () => {
    // Without this, every fixture above could pass by the tracker refusing
    // everything, which would make the agreement meaningless.
    expect(trackerRefuses(VALID_CONFIG, WSS)).toBe(false);
  });
});
