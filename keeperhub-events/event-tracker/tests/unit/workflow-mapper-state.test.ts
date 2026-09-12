import { ethers } from "ethers";
import { describe, expect, it } from "vitest";
import type { NetworkConfig, NetworksMap, RawWorkflow } from "../../lib/types";
import { isStateRegistration } from "../../src/listener/registry";
import { buildRegistration } from "../../src/listener/workflow-mapper";

/**
 * Mapping of a `stateThreshold` trigger node (issue #2240). The load-bearing
 * assertion is that the ABI output types travel with the call: the decoder is
 * handed raw return data and cannot recover them from the calldata.
 */

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

const USER = "0x2222222222222222222222222222222222222222";

// Aave V3's getUserAccountData: six uint256 outputs, healthFactor last.
const POOL_ABI = JSON.stringify([
  {
    type: "function",
    name: "getUserAccountData",
    stateMutability: "view",
    inputs: [{ name: "user", type: "address" }],
    outputs: [
      { name: "totalCollateralBase", type: "uint256" },
      { name: "totalDebtBase", type: "uint256" },
      { name: "availableBorrowsBase", type: "uint256" },
      { name: "currentLiquidationThreshold", type: "uint256" },
      { name: "ltv", type: "uint256" },
      { name: "healthFactor", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "paused",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "poke",
    stateMutability: "nonpayable",
    inputs: [],
    outputs: [],
  },
]);

function makeWorkflow(
  configOverrides: Record<string, unknown> = {},
): RawWorkflow {
  return {
    id: "wf-1",
    name: "Health factor guard",
    userId: "user-1",
    nodes: [
      {
        data: {
          config: {
            network: String(CHAIN_ID),
            triggerType: "stateThreshold",
            contractAddress: "0x1111111111111111111111111111111111111111",
            contractABI: POOL_ABI,
            abiFunction: "getUserAccountData",
            functionArgs: [USER],
            outputPath: "healthFactor",
            comparator: "lt",
            threshold: "1.05",
            decimals: 18,
            ...configOverrides,
          },
        },
      },
    ],
  } as RawWorkflow;
}

function build(configOverrides: Record<string, unknown> = {}) {
  const reg = buildRegistration(makeWorkflow(configOverrides), NETWORKS);
  return reg !== null && isStateRegistration(reg) ? reg : null;
}

describe("buildRegistration - stateThreshold", () => {
  it("resolves the call, its outputs and the selected index", () => {
    const reg = build();
    expect(reg).not.toBeNull();
    const sub = reg?.subscription;
    expect(sub?.callData).toBe(
      new ethers.Interface(JSON.parse(POOL_ABI)).encodeFunctionData(
        "getUserAccountData",
        [USER],
      ),
    );
    expect(sub?.outputTypes).toHaveLength(6);
    expect(sub?.outputTypes?.[5]).toContain("healthFactor");
    expect(sub?.outputIndex).toBe(5);
    // 1.05 at 18 decimals.
    expect(sub?.threshold).toBe(1_050_000_000_000_000_000n);
    expect(sub?.hysteresis).toBeUndefined();
  });

  it("accepts an output index as a number or a numeric string", () => {
    expect(build({ outputPath: 5 })?.subscription.outputIndex).toBe(5);
    expect(build({ outputPath: "5" })?.subscription.outputIndex).toBe(5);
    expect(build({ outputPath: undefined })?.subscription.outputIndex).toBe(0);
  });

  it("scales the hysteresis band by the same decimals as the threshold", () => {
    const reg = build({ hysteresis: "0.02" });
    expect(reg?.subscription.hysteresis).toBe(20_000_000_000_000_000n);
  });

  it("gives a subscription id that moves with the threshold but not the RPC", () => {
    const base = build();
    const sameConfig = build();
    const higher = build({ threshold: "1.10" });
    expect(sameConfig?.subscription.subscriptionId).toBe(
      base?.subscription.subscriptionId,
    );
    // A changed line is a different subscription, so the first breach under
    // the new one opens a fresh arming episode instead of inheriting a
    // generation that would suppress it.
    expect(higher?.subscription.subscriptionId).not.toBe(
      base?.subscription.subscriptionId,
    );

    const otherWss: NetworksMap = {
      [CHAIN_ID]: { ...NETWORK, defaultPrimaryWss: "ws://other:8546" },
    };
    const rotated = buildRegistration(makeWorkflow(), otherWss);
    expect(
      rotated !== null && isStateRegistration(rotated)
        ? rotated.subscription.subscriptionId
        : null,
    ).toBe(base?.subscription.subscriptionId);
    // The connection is still part of what restarts the listener.
    expect(
      rotated !== null && isStateRegistration(rotated)
        ? rotated.configHash
        : null,
    ).not.toBe(base?.configHash);
  });

  it("refuses a non-numeric output rather than decoding it at runtime", () => {
    expect(build({ abiFunction: "paused", outputPath: 0 })).toBeNull();
  });

  it("refuses a function that returns nothing to compare", () => {
    expect(build({ abiFunction: "poke", functionArgs: [] })).toBeNull();
  });

  it("refuses an outputPath that names no output", () => {
    expect(build({ outputPath: "collateral" })).toBeNull();
    expect(build({ outputPath: 9 })).toBeNull();
  });

  it("refuses an unknown comparator", () => {
    expect(build({ comparator: "eq" })).toBeNull();
    expect(build({ comparator: undefined })).toBeNull();
  });

  it("refuses a threshold that is not a decimal number", () => {
    expect(build({ threshold: "not-a-number" })).toBeNull();
    expect(build({ threshold: undefined })).toBeNull();
  });

  it("refuses a negative or unparseable hysteresis instead of defaulting it", () => {
    expect(build({ hysteresis: "-0.02" })).toBeNull();
    expect(build({ hysteresis: "wide" })).toBeNull();
  });

  it("refuses a function the ABI does not declare", () => {
    expect(build({ abiFunction: "getReserveData" })).toBeNull();
  });

  it("refuses arguments that do not match the function signature", () => {
    expect(build({ functionArgs: [] })).toBeNull();
    expect(build({ functionArgs: ["not-an-address"] })).toBeNull();
  });

  it("leaves the event path untouched", () => {
    const reg = buildRegistration(
      {
        id: "wf-2",
        name: "Event",
        userId: "user-1",
        nodes: [
          {
            data: {
              config: {
                network: String(CHAIN_ID),
                eventName: "Transfer",
                contractAddress: "0x1111111111111111111111111111111111111111",
                contractABI: JSON.stringify([
                  {
                    type: "event",
                    name: "Transfer",
                    inputs: [
                      { name: "from", type: "address", indexed: true },
                      { name: "to", type: "address", indexed: true },
                      { name: "value", type: "uint256", indexed: false },
                    ],
                  },
                ]),
              },
            },
          },
        ],
      } as RawWorkflow,
      NETWORKS,
    );
    expect(reg).not.toBeNull();
    expect(reg !== null && isStateRegistration(reg)).toBe(false);
  });
});
