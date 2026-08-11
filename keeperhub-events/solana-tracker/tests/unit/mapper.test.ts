import { afterEach, describe, expect, it } from "vitest";
import type {
  DiscoveryData,
  NetworkConfig,
  RawTriggerConfig,
  RawWorkflow,
} from "../../lib/types";
import { buildRegistrations } from "../../src/mapper";

const VALID_PROGRAM = "So11111111111111111111111111111111111111112";

function solanaNetwork(
  chainId: number,
  overrides: Partial<NetworkConfig> = {},
): NetworkConfig {
  return {
    id: `chain-${chainId}`,
    chainId,
    name: `Solana ${chainId}`,
    symbol: "SOL",
    chainType: "solana",
    defaultPrimaryRpc: "https://rpc.example",
    defaultFallbackRpc: "",
    defaultPrimaryWss: "wss://ws.example",
    defaultFallbackWss: "",
    isTestnet: false,
    isEnabled: true,
    ...overrides,
  };
}

function eventWorkflow(
  id: string,
  network: string,
  programId: string,
  extra: Partial<RawTriggerConfig> = {},
): RawWorkflow {
  return {
    id,
    userId: "user-1",
    name: id,
    nodes: [
      {
        data: {
          type: "trigger",
          config: { triggerType: "Event", network, programId, ...extra },
        },
      },
    ],
  };
}

function blockWorkflow(
  id: string,
  network: string,
  blockInterval?: string,
): RawWorkflow {
  return {
    id,
    userId: "user-1",
    name: id,
    nodes: [
      {
        data: {
          type: "trigger",
          config: { triggerType: "Block", network, blockInterval },
        },
      },
    ],
  };
}

function data(overrides: Partial<DiscoveryData>): DiscoveryData {
  return {
    eventWorkflows: [],
    blockWorkflows: [],
    networks: {},
    ...overrides,
  };
}

afterEach(() => {
  // Empty (not "signatures") so the mapper's env check yields the default mode.
  process.env.SOLANA_SOURCE_MODE = "";
});

describe("buildRegistrations", () => {
  it("builds one registration per Solana chain with resolved endpoints", () => {
    const regs = buildRegistrations(
      data({
        eventWorkflows: [eventWorkflow("wf-1", "101", VALID_PROGRAM)],
        networks: { 101: solanaNetwork(101) },
      }),
    );
    expect(regs).toHaveLength(1);
    expect(regs[0].chainId).toBe(101);
    expect(regs[0].eventTriggers).toHaveLength(1);
    expect(regs[0].eventTriggers[0].programId).toBe(VALID_PROGRAM);
    expect(regs[0].rpcUrl).toBe("https://rpc.example");
    expect(regs[0].wssUrl).toBe("wss://ws.example");
    expect(regs[0].commitment).toBe("confirmed");
  });

  it("skips event triggers whose programId is not valid base58", () => {
    const regs = buildRegistrations(
      data({
        eventWorkflows: [eventWorkflow("wf-1", "101", "not-a-valid-key!!!")],
        networks: { 101: solanaNetwork(101) },
      }),
    );
    expect(regs).toEqual([]);
  });

  it("parses block interval and defaults invalid/absent intervals to 1", () => {
    const regs = buildRegistrations(
      data({
        blockWorkflows: [
          blockWorkflow("wf-5", "101", "5"),
          blockWorkflow("wf-x", "101"),
        ],
        networks: { 101: solanaNetwork(101) },
      }),
    );
    const intervals = regs[0].blockTriggers
      .map((t) => t.blockInterval)
      .sort((a, b) => a - b);
    expect(intervals).toEqual([1, 5]);
  });

  it("skips a chain whose network lacks a usable WSS endpoint", () => {
    const regs = buildRegistrations(
      data({
        eventWorkflows: [eventWorkflow("wf-1", "101", VALID_PROGRAM)],
        networks: { 101: solanaNetwork(101, { defaultPrimaryWss: "" }) },
      }),
    );
    expect(regs).toEqual([]);
  });

  it("skips non-Solana chains", () => {
    const regs = buildRegistrations(
      data({
        eventWorkflows: [eventWorkflow("wf-1", "1", VALID_PROGRAM)],
        networks: { 1: solanaNetwork(1, { chainType: "evm" }) },
      }),
    );
    expect(regs).toEqual([]);
  });

  it("changes the config hash and sourceMode when SOLANA_SOURCE_MODE=signatures", () => {
    const input = data({
      eventWorkflows: [eventWorkflow("wf-1", "101", VALID_PROGRAM)],
      networks: { 101: solanaNetwork(101) },
    });

    const defaultReg = buildRegistrations(input)[0];
    expect(defaultReg.sourceMode).toBeUndefined();

    process.env.SOLANA_SOURCE_MODE = "signatures";
    const signaturesReg = buildRegistrations(input)[0];
    expect(signaturesReg.sourceMode).toBe("signatures");
    expect(signaturesReg.configHash).not.toBe(defaultReg.configHash);
  });
});
