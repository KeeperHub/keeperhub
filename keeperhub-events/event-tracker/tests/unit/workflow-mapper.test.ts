import { describe, expect, it } from "vitest";
import type { NetworkConfig, NetworksMap } from "../../lib/types";
import {
  buildRegistration,
  hashRegistration,
} from "../../src/listener/workflow-mapper";

const CHAIN_ID = 31_337;

const NETWORK: NetworkConfig = {
  id: "local",
  chainId: CHAIN_ID,
  name: "Anvil",
  symbol: "ETH",
  chainType: "evm",
  defaultPrimaryRpc: "http://localhost:8546",
  defaultFallbackRpc: "http://localhost:8546",
  defaultPrimaryWss: "ws://localhost:8546",
  defaultFallbackWss: "ws://localhost:8546",
  isTestnet: true,
  isEnabled: true,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

const NETWORKS: NetworksMap = { [CHAIN_ID]: NETWORK };

const ERC20_ABI = JSON.stringify([
  {
    type: "event",
    name: "Transfer",
    inputs: [
      { name: "from", type: "address", indexed: true },
      { name: "to", type: "address", indexed: true },
      { name: "value", type: "uint256", indexed: false },
    ],
  },
  {
    type: "function",
    name: "transfer",
    inputs: [],
    outputs: [],
    stateMutability: "nonpayable",
  },
]);

function makeWorkflow(
  overrides: Record<string, unknown> = {},
  configOverrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "wf-1",
    name: "Test Workflow",
    userId: "user-1",
    nodes: [
      {
        data: {
          config: {
            network: String(CHAIN_ID),
            eventName: "Transfer",
            contractABI: ERC20_ABI,
            contractAddress: "0x1111111111111111111111111111111111111111",
            ...configOverrides,
          },
        },
      },
    ],
    ...overrides,
  };
}

describe("buildRegistration", () => {
  it("maps a valid workflow into a WorkflowRegistration", () => {
    const reg = buildRegistration(makeWorkflow(), NETWORKS);
    expect(reg).not.toBeNull();
    expect(reg).toMatchObject({
      workflowId: "wf-1",
      userId: "user-1",
      workflowName: "Test Workflow",
      chainId: CHAIN_ID,
      wssUrl: "ws://localhost:8546",
      fallbackWssUrl: "ws://localhost:8546",
      contractAddress: "0x1111111111111111111111111111111111111111",
      eventName: "Transfer",
    });
    expect(reg?.rawEventsAbi).toHaveLength(1);
    expect(reg?.rawEventsAbi[0].name).toBe("Transfer");
    expect(reg?.eventsAbiStrings[0]).toBe(
      "event Transfer(address indexed from, address indexed to, uint256 value)",
    );
  });

  it("filters non-event entries out of rawEventsAbi", () => {
    const reg = buildRegistration(makeWorkflow(), NETWORKS);
    expect(reg?.rawEventsAbi.every((e) => e.type === "event")).toBe(true);
  });

  describe("configHash", () => {
    it("attaches a configHash to the built registration", () => {
      const reg = buildRegistration(makeWorkflow(), NETWORKS);
      expect(reg?.configHash).toMatch(/^[0-9a-f]{64}$/);
    });

    it("is stable across identical inputs", () => {
      const a = buildRegistration(makeWorkflow(), NETWORKS);
      const b = buildRegistration(makeWorkflow(), NETWORKS);
      expect(a?.configHash).toBe(b?.configHash);
    });

    it("ignores workflowName (cosmetic)", () => {
      const a = buildRegistration(makeWorkflow({ name: "A" }), NETWORKS);
      const b = buildRegistration(makeWorkflow({ name: "B" }), NETWORKS);
      expect(a?.configHash).toBe(b?.configHash);
    });

    it("changes when contractAddress changes", () => {
      const a = buildRegistration(makeWorkflow(), NETWORKS);
      const b = buildRegistration(
        makeWorkflow(
          {},
          { contractAddress: "0x2222222222222222222222222222222222222222" },
        ),
        NETWORKS,
      );
      expect(a?.configHash).not.toBe(b?.configHash);
    });

    it("changes when eventName changes", () => {
      const a = buildRegistration(makeWorkflow(), NETWORKS);
      const b = buildRegistration(
        makeWorkflow({}, { eventName: "Approval" }),
        NETWORKS,
      );
      expect(a?.configHash).not.toBe(b?.configHash);
    });

    it("changes when chainId changes", () => {
      const otherNetworks: NetworksMap = {
        ...NETWORKS,
        1: { ...NETWORK, chainId: 1 },
      };
      const a = buildRegistration(makeWorkflow(), NETWORKS);
      const b = buildRegistration(
        makeWorkflow({}, { network: "1" }),
        otherNetworks,
      );
      expect(a?.configHash).not.toBe(b?.configHash);
    });

    it("changes when userId changes", () => {
      const a = buildRegistration(makeWorkflow(), NETWORKS);
      const b = buildRegistration(makeWorkflow({ userId: "user-2" }), NETWORKS);
      expect(a?.configHash).not.toBe(b?.configHash);
    });

    it("changes when fallbackWssUrl changes", () => {
      // Switching fallback providers is a real config change: the
      // reconciler must restart the listener so the new URL becomes the
      // entry's identity in the provider manager.
      const a = buildRegistration(makeWorkflow(), NETWORKS);
      const networksB: NetworksMap = {
        [CHAIN_ID]: {
          ...NETWORK,
          defaultFallbackWss: "wss://different-fallback.example.com",
        },
      };
      const b = buildRegistration(makeWorkflow(), networksB);
      expect(a?.configHash).not.toBe(b?.configHash);
    });

    it("hashRegistration matches the hash in the built registration", () => {
      const reg = buildRegistration(makeWorkflow(), NETWORKS);
      expect(reg).not.toBeNull();
      if (!reg) {
        return;
      }
      // Re-compute the hash from the registration fields; it should match
      // the embedded hash. Locks in the contract.
      expect(hashRegistration(reg)).toBe(reg.configHash);
    });
  });

  it("returns null when id is missing", () => {
    expect(
      buildRegistration(makeWorkflow({ id: undefined }), NETWORKS),
    ).toBeNull();
  });

  it("returns null when there are no nodes", () => {
    expect(buildRegistration(makeWorkflow({ nodes: [] }), NETWORKS)).toBeNull();
  });

  it("returns null when node.data.config is missing", () => {
    expect(
      buildRegistration(makeWorkflow({ nodes: [{ data: {} }] }), NETWORKS),
    ).toBeNull();
  });

  it("returns null when chainId references an unknown network", () => {
    expect(
      buildRegistration(makeWorkflow({}, { network: "9999" }), NETWORKS),
    ).toBeNull();
  });

  it("returns null when chainId is not numeric", () => {
    expect(
      buildRegistration(
        makeWorkflow({}, { network: "not-a-number" }),
        NETWORKS,
      ),
    ).toBeNull();
  });

  // The DB column for defaultPrimaryWss is nullable. If it slips through
  // to provider creation, ethers' SocketSubscriber.start() leaves the
  // eth_subscribe rejection uncaught and crashes the pod - so reject here.
  it("returns null when defaultPrimaryWss is null", () => {
    const networks: NetworksMap = {
      [CHAIN_ID]: {
        ...NETWORK,
        defaultPrimaryWss: null as unknown as string,
      },
    };
    expect(buildRegistration(makeWorkflow(), networks)).toBeNull();
  });

  it("returns null when defaultPrimaryWss is empty", () => {
    const networks: NetworksMap = {
      [CHAIN_ID]: { ...NETWORK, defaultPrimaryWss: "" },
    };
    expect(buildRegistration(makeWorkflow(), networks)).toBeNull();
  });

  it("returns null when defaultPrimaryWss is an HTTP URL", () => {
    const networks: NetworksMap = {
      [CHAIN_ID]: {
        ...NETWORK,
        defaultPrimaryWss: "https://eth-mainnet.example.com",
      },
    };
    expect(buildRegistration(makeWorkflow(), networks)).toBeNull();
  });

  it("accepts a wss:// URL", () => {
    const networks: NetworksMap = {
      [CHAIN_ID]: {
        ...NETWORK,
        defaultPrimaryWss: "wss://eth-mainnet.example.com",
      },
    };
    const reg = buildRegistration(makeWorkflow(), networks);
    expect(reg?.wssUrl).toBe("wss://eth-mainnet.example.com");
  });

  // defaultFallbackWss has the same nullable-DB-column issue as the
  // primary, but a bad fallback should NOT fail the whole workflow - the
  // listener can still run on primary alone.
  describe("defaultFallbackWss handling", () => {
    it("includes fallbackWssUrl when valid", () => {
      const networks: NetworksMap = {
        [CHAIN_ID]: {
          ...NETWORK,
          defaultPrimaryWss: "wss://primary.example.com",
          defaultFallbackWss: "wss://fallback.example.com",
        },
      };
      const reg = buildRegistration(makeWorkflow(), networks);
      expect(reg?.fallbackWssUrl).toBe("wss://fallback.example.com");
    });

    it("drops a null fallback (workflow still runs on primary)", () => {
      const networks: NetworksMap = {
        [CHAIN_ID]: {
          ...NETWORK,
          defaultFallbackWss: null as unknown as string,
        },
      };
      const reg = buildRegistration(makeWorkflow(), networks);
      expect(reg).not.toBeNull();
      expect(reg?.fallbackWssUrl).toBeUndefined();
    });

    it("drops an empty fallback", () => {
      const networks: NetworksMap = {
        [CHAIN_ID]: { ...NETWORK, defaultFallbackWss: "" },
      };
      const reg = buildRegistration(makeWorkflow(), networks);
      expect(reg?.fallbackWssUrl).toBeUndefined();
    });

    it("drops a fallback with the wrong scheme", () => {
      const networks: NetworksMap = {
        [CHAIN_ID]: {
          ...NETWORK,
          defaultFallbackWss: "https://eth-mainnet.example.com",
        },
      };
      const reg = buildRegistration(makeWorkflow(), networks);
      expect(reg?.fallbackWssUrl).toBeUndefined();
    });
  });

  it("returns null when contractAddress is missing", () => {
    expect(
      buildRegistration(
        makeWorkflow({}, { contractAddress: undefined }),
        NETWORKS,
      ),
    ).toBeNull();
  });

  it("returns null when eventName is missing", () => {
    expect(
      buildRegistration(makeWorkflow({}, { eventName: undefined }), NETWORKS),
    ).toBeNull();
  });

  it("returns null when contractABI is not valid JSON", () => {
    expect(
      buildRegistration(
        makeWorkflow({}, { contractABI: "{not valid json" }),
        NETWORKS,
      ),
    ).toBeNull();
  });

  it("returns null when contractABI has no event entries", () => {
    const onlyFunctions = JSON.stringify([
      {
        type: "function",
        name: "foo",
        inputs: [],
        outputs: [],
        stateMutability: "view",
      },
    ]);
    expect(
      buildRegistration(
        makeWorkflow({}, { contractABI: onlyFunctions }),
        NETWORKS,
      ),
    ).toBeNull();
  });
});
