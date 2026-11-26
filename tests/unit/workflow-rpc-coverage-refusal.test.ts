import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const sources = vi.hoisted(() => ({
  loadOwnRpcOnlyChains: vi.fn(),
  loadOrgRpcConfigs: vi.fn(),
  loadPlatform: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/rpc/engine/sources/db-org-source", () => ({
  loadOwnRpcOnlyChains: sources.loadOwnRpcOnlyChains,
  loadOrgRpcConfigs: sources.loadOrgRpcConfigs,
}));
vi.mock("@/lib/rpc/engine/runtime", () => ({
  platformRpcSource: { load: sources.loadPlatform },
  orgRpcSource: { invalidate: vi.fn() },
}));

import { OrgRpcErrorCode } from "@/lib/rpc/engine/org/codes";
import {
  workflowCoverageGaps,
  workflowCoverageRefusal,
} from "@/lib/rpc/engine/org/service";
import { RpcRouteErrorCode } from "@/lib/rpc/engine/route-error";
import { RPC_SELECTION_CONFIG_KEY } from "@/lib/rpc/engine/scope";
import { SecretUrl } from "@/lib/rpc/engine/secret-url";
import type { PlatformChainRecord } from "@/lib/rpc/engine/sources/platform-source";
import {
  type OrgRpcConfig,
  RpcChainType,
  RpcSelectionMode,
} from "@/lib/rpc/engine/types";

const ORG_ID = "org_1";
const MAINNET = 1;

const url = (value: string): SecretUrl => SecretUrl.parse(value);

function platformRecord(chainId: number): PlatformChainRecord {
  return {
    chain: {
      chainId,
      name: `Chain ${chainId}`,
      chainType: RpcChainType.EVM,
      isEnabled: true,
    },
    endpoints: { httpPrimary: url(`https://kh-${chainId}.example.com/key`) },
  };
}

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

function workflow(selection?: string) {
  const rpc =
    selection === undefined ? {} : { [RPC_SELECTION_CONFIG_KEY]: selection };
  return {
    id: "wf_1",
    name: "Flow",
    nodes: [
      {
        id: "a1",
        data: {
          type: "action",
          label: "Read",
          config: { network: String(MAINNET), ...rpc },
        },
      },
    ],
  };
}

function setOrg(ownRpcOnly: boolean, configs: OrgRpcConfig[]): void {
  sources.loadOwnRpcOnlyChains.mockResolvedValue(
    new Set(ownRpcOnly ? [MAINNET] : [])
  );
  sources.loadOrgRpcConfigs.mockResolvedValue(configs);
}

beforeEach(() => {
  vi.clearAllMocks();
  sources.loadPlatform.mockImplementation((chainId: number) =>
    Promise.resolve(platformRecord(chainId))
  );
});

describe("workflowCoverageRefusal", () => {
  it("lets a workflow through when the org has no configs and policy off", async () => {
    setOrg(false, []);
    await expect(
      workflowCoverageRefusal(ORG_ID, workflow())
    ).resolves.toBeNull();
    await expect(
      workflowCoverageRefusal(ORG_ID, workflow(RpcSelectionMode.PLATFORM))
    ).resolves.toBeNull();
  });

  it("refuses a node pinned to a config the org does not have", async () => {
    setOrg(false, [config()]);
    const refusal = await workflowCoverageRefusal(ORG_ID, workflow("cfg_gone"));
    expect(refusal).toMatchObject({
      status: 409,
      code: OrgRpcErrorCode.COVERAGE_GAPS,
    });
    expect(refusal?.gaps).toEqual([
      expect.objectContaining({
        nodeId: "a1",
        chainId: MAINNET,
        code: RpcRouteErrorCode.CONFIG_NOT_FOUND,
      }),
    ]);
  });

  it("refuses KeeperHub under own RPC only", async () => {
    setOrg(true, [config()]);
    const gaps = await workflowCoverageGaps(
      ORG_ID,
      workflow(RpcSelectionMode.PLATFORM)
    );
    expect(gaps.map((gap) => gap.code)).toEqual([
      RpcRouteErrorCode.PLATFORM_FORBIDDEN,
    ]);
  });

  it("does not blame a save for a gap the stored version already has", async () => {
    setOrg(false, [config()]);
    const stored = workflow("cfg_gone");
    await expect(
      workflowCoverageRefusal(ORG_ID, stored, stored.nodes)
    ).resolves.toBeNull();
    await expect(
      workflowCoverageRefusal(ORG_ID, stored, workflow().nodes)
    ).resolves.not.toBeNull();
  });

  it("ignores gaps from KeeperHub's own chain setup", async () => {
    setOrg(false, []);
    sources.loadPlatform.mockResolvedValue(null);
    await expect(
      workflowCoverageRefusal(ORG_ID, workflow())
    ).resolves.toBeNull();
  });

  it("loads nothing for a workflow that uses no chain", async () => {
    await expect(
      workflowCoverageRefusal(ORG_ID, { id: "wf", name: "Flow", nodes: [] })
    ).resolves.toBeNull();
    expect(sources.loadOwnRpcOnlyChains).not.toHaveBeenCalled();
  });
});
