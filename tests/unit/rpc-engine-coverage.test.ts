import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  chainUsagesOf,
  findCoverageGaps,
  type NodeChainUsage,
} from "@/lib/rpc/engine/org/coverage";
import { RpcRouteErrorCode } from "@/lib/rpc/engine/route-error";
import { RPC_SELECTION_CONFIG_KEY } from "@/lib/rpc/engine/scope";
import { SecretUrl } from "@/lib/rpc/engine/secret-url";
import type { PlatformChainRecord } from "@/lib/rpc/engine/sources/platform-source";
import {
  type OrgRpcConfig,
  RpcChainType,
  RpcPurpose,
  RpcSelectionMode,
} from "@/lib/rpc/engine/types";
import { WorkflowTriggerEnum } from "@/lib/workflow/store";

const ORG_ID = "org_1";
const MAINNET = 1;
const BASE = 8453;

const url = (value: string): SecretUrl => SecretUrl.parse(value);

function trigger(id: string, triggerType: string, network?: string) {
  return {
    id,
    data: { type: "trigger", label: id, config: { triggerType, network } },
  };
}

function action(id: string, config: Record<string, unknown>) {
  return { id, data: { type: "action", label: id, config } };
}

function platformRecord(chainId: number): PlatformChainRecord {
  return {
    chain: {
      chainId,
      name: `Chain ${chainId}`,
      chainType: RpcChainType.EVM,
      isEnabled: true,
    },
    endpoints: {
      httpPrimary: url(`https://kh-${chainId}.example.com/key`),
      wssPrimary: url(`wss://kh-${chainId}.example.com/key`),
    },
  };
}

const platform = new Map([
  [MAINNET, platformRecord(MAINNET)],
  [BASE, platformRecord(BASE)],
]);

function config(overrides: Partial<OrgRpcConfig> = {}): OrgRpcConfig {
  return {
    id: "cfg_main",
    name: "Main",
    chainId: MAINNET,
    enabled: true,
    isDefault: true,
    httpPrimary: url("https://org.example.com/key"),
    ...overrides,
  };
}

describe("chainUsagesOf", () => {
  it("reads chains from actions and listening triggers only", () => {
    const usages = chainUsagesOf({
      id: "wf_1",
      name: "Flow",
      nodes: [
        trigger("t1", WorkflowTriggerEnum.EVENT, String(MAINNET)),
        action("a1", { network: String(BASE) }),
        action("a2", { actionType: "Condition" }),
      ],
    });

    expect(
      usages.map((usage) => [usage.nodeId, usage.chainId, usage.purpose])
    ).toEqual([
      ["t1", MAINNET, RpcPurpose.SUBSCRIBE],
      ["a1", BASE, RpcPurpose.READ],
    ]);
  });

  it("ignores triggers that do not listen to a chain", () => {
    const usages = chainUsagesOf({
      id: "wf_1",
      name: "Flow",
      nodes: [trigger("t1", WorkflowTriggerEnum.MANUAL, String(MAINNET))],
    });
    expect(usages).toEqual([]);
  });

  it("skips networks that are only known at run time", () => {
    const usages = chainUsagesOf({
      id: "wf_1",
      name: "Flow",
      nodes: [action("a1", { network: "{{@trigger:Trigger.chainId}}" })],
    });
    expect(usages).toEqual([]);
  });

  it("marks private mempool writes and reads the node selection", () => {
    const [usage] = chainUsagesOf({
      id: "wf_1",
      name: "Flow",
      nodes: [
        action("a1", {
          network: String(MAINNET),
          usePrivateMempool: true,
          [RPC_SELECTION_CONFIG_KEY]: "cfg_archive",
        }),
      ],
    });
    expect(usage.purpose).toBe(RpcPurpose.WRITE);
    expect(usage.privateMempool).toEqual({ strict: true });
    expect(usage.selection).toEqual({
      mode: RpcSelectionMode.CONFIG,
      configId: "cfg_archive",
    });
  });

  it("skips actions that do not call their chain over RPC", () => {
    const nodes = [
      action("explorer", { network: String(MAINNET), actionType: "explore" }),
      action("read", { network: String(MAINNET), actionType: "read" }),
    ];
    const usages = chainUsagesOf(
      { id: "wf_1", name: "Flow", nodes },
      (actionType) => (actionType === "explore" ? null : "network")
    );
    expect(usages.map((usage) => usage.nodeId)).toEqual(["read"]);
  });

  it("reads an action's network from the key its picker uses", () => {
    const nodes = [action("risk", { chain: String(BASE), actionType: "scan" })];
    const [usage] = chainUsagesOf(
      { id: "wf_1", name: "Flow", nodes },
      () => "chain"
    );
    expect(usage?.chainId).toBe(BASE);
  });

  it("tolerates malformed node lists", () => {
    expect(chainUsagesOf({ id: "wf", name: "Flow", nodes: null })).toEqual([]);
  });
});

describe("findCoverageGaps", () => {
  function usages(
    nodes: unknown[],
    workflowId = "wf_1"
  ): readonly NodeChainUsage[] {
    return chainUsagesOf({ id: workflowId, name: "Flow", nodes });
  }

  it("finds nothing when own RPC only is off", () => {
    const gaps = findCoverageGaps({
      organizationId: ORG_ID,
      usages: usages([action("a1", { network: String(MAINNET) })]),
      ownRpcOnlyChains: new Set<number>(),
      configs: [],
      platform,
    });
    expect(gaps).toEqual([]);
  });

  it("names every node on a chain the organization has not covered", () => {
    const gaps = findCoverageGaps({
      organizationId: ORG_ID,
      usages: usages([
        action("a1", { network: String(MAINNET) }),
        action("a2", { network: String(BASE) }),
      ]),
      ownRpcOnlyChains: new Set([MAINNET, BASE, 137]),
      configs: [config()],
      platform,
    });
    expect(gaps).toEqual([
      expect.objectContaining({
        workflowId: "wf_1",
        nodeId: "a2",
        chainId: BASE,
        code: RpcRouteErrorCode.NOT_COVERED,
      }),
    ]);
  });

  it("only checks chains that are set to own RPC only", () => {
    const gaps = findCoverageGaps({
      organizationId: ORG_ID,
      usages: usages([
        action("a1", { network: String(MAINNET) }),
        action("a2", { network: String(BASE) }),
      ]),
      ownRpcOnlyChains: new Set([MAINNET]),
      configs: [],
      platform,
    });
    expect(gaps.map((gap) => [gap.nodeId, gap.chainId])).toEqual([
      ["a1", MAINNET],
    ]);
  });

  it("counts Tempo payment triggers as listeners that need a WebSocket URL", () => {
    const gaps = findCoverageGaps({
      organizationId: ORG_ID,
      usages: usages([
        trigger("t1", WorkflowTriggerEnum.TEMPO_PAYMENT, String(MAINNET)),
      ]),
      ownRpcOnlyChains: new Set([MAINNET]),
      configs: [config()],
      platform,
    });
    expect(gaps.map((gap) => [gap.nodeId, gap.code])).toEqual([
      ["t1", RpcRouteErrorCode.NOT_COVERED],
    ]);
  });

  it("needs a WebSocket URL for listening triggers", () => {
    const gaps = findCoverageGaps({
      organizationId: ORG_ID,
      usages: usages([
        trigger("t1", WorkflowTriggerEnum.BLOCK, String(MAINNET)),
      ]),
      ownRpcOnlyChains: new Set([MAINNET, BASE, 137]),
      configs: [config()],
      platform,
    });
    expect(gaps.map((gap) => gap.code)).toEqual([
      RpcRouteErrorCode.NOT_COVERED,
    ]);

    const covered = findCoverageGaps({
      organizationId: ORG_ID,
      usages: usages([
        trigger("t1", WorkflowTriggerEnum.BLOCK, String(MAINNET)),
      ]),
      ownRpcOnlyChains: new Set([MAINNET, BASE, 137]),
      configs: [config({ wssPrimary: url("wss://org.example.com/key") })],
      platform,
    });
    expect(covered).toEqual([]);
  });

  it("flags nodes pinned to a config that is gone, whatever the policy", () => {
    const gaps = findCoverageGaps({
      organizationId: ORG_ID,
      usages: usages([
        action("a1", {
          network: String(MAINNET),
          [RPC_SELECTION_CONFIG_KEY]: "cfg_gone",
        }),
      ]),
      ownRpcOnlyChains: new Set<number>(),
      configs: [config()],
      platform,
    });
    expect(gaps.map((gap) => gap.code)).toEqual([
      RpcRouteErrorCode.CONFIG_NOT_FOUND,
    ]);
  });

  it("ignores chains KeeperHub has disabled, which no config can fix", () => {
    const gaps = findCoverageGaps({
      organizationId: ORG_ID,
      usages: usages([action("a1", { network: "137" })]),
      ownRpcOnlyChains: new Set([MAINNET, BASE, 137]),
      configs: [config()],
      platform,
    });
    expect(gaps).toEqual([]);
  });

  it("flags nodes pinned to KeeperHub under own RPC only", () => {
    const gaps = findCoverageGaps({
      organizationId: ORG_ID,
      usages: usages([
        action("a1", {
          network: String(MAINNET),
          [RPC_SELECTION_CONFIG_KEY]: RpcSelectionMode.PLATFORM,
        }),
      ]),
      ownRpcOnlyChains: new Set([MAINNET, BASE, 137]),
      configs: [config()],
      platform,
    });
    expect(gaps.map((gap) => gap.code)).toEqual([
      RpcRouteErrorCode.PLATFORM_FORBIDDEN,
    ]);
  });
});
