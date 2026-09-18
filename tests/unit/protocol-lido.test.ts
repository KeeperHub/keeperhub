import { describe, expect, it } from "vitest";
import { getProtocol, registerProtocol } from "@/lib/protocol-registry";
import lidoDef from "@/protocols/lido";

const KEBAB_CASE_REGEX = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const ETH_ADDRESS_REGEX = /^0x[0-9a-fA-F]{40}$/;

describe("Lido Protocol Definition", () => {
  it("imports without throwing", () => {
    expect(lidoDef).toBeDefined();
    expect(lidoDef.name).toBe("Lido");
    expect(lidoDef.slug).toBe("lido");
  });

  it("protocol slug is valid kebab-case", () => {
    expect(lidoDef.slug).toMatch(KEBAB_CASE_REGEX);
  });

  it("all action slugs are valid kebab-case", () => {
    for (const action of lidoDef.actions) {
      expect(action.slug).toMatch(KEBAB_CASE_REGEX);
    }
  });

  it("all contract addresses are valid Ethereum addresses", () => {
    for (const [key, contract] of Object.entries(lidoDef.contracts)) {
      for (const [chainId, address] of Object.entries(contract.addresses)) {
        expect(
          address,
          `contract "${key}" chain "${chainId}" has invalid address`
        ).toMatch(ETH_ADDRESS_REGEX);
      }
    }
  });

  it("every action references an existing contract", () => {
    const contractKeys = new Set(Object.keys(lidoDef.contracts));
    for (const action of lidoDef.actions) {
      expect(
        contractKeys.has(action.contract),
        `action "${action.slug}" references unknown contract "${action.contract}"`
      ).toBe(true);
    }
  });

  it("has no duplicate action slugs", () => {
    const slugs = lidoDef.actions.map((a) => a.slug);
    const uniqueSlugs = new Set(slugs);
    expect(slugs.length).toBe(uniqueSlugs.size);
  });

  it("all read actions define outputs", () => {
    const readActions = lidoDef.actions.filter((a) => a.type === "read");
    for (const action of readActions) {
      expect(
        action.outputs,
        `read action "${action.slug}" must have outputs`
      ).toBeDefined();
      expect(
        action.outputs?.length,
        `read action "${action.slug}" must have at least one output`
      ).toBeGreaterThan(0);
    }
  });

  it("each action's contract has at least one chain address", () => {
    for (const action of lidoDef.actions) {
      const contract = lidoDef.contracts[action.contract];
      expect(contract).toBeDefined();
      expect(
        Object.keys(contract.addresses).length,
        `contract "${action.contract}" for action "${action.slug}" must have at least one chain`
      ).toBeGreaterThan(0);
    }
  });

  it("has exactly 18 actions", () => {
    expect(lidoDef.actions).toHaveLength(18);
  });

  it("has 6 write actions and 12 read actions", () => {
    const readActions = lidoDef.actions.filter((a) => a.type === "read");
    const writeActions = lidoDef.actions.filter((a) => a.type === "write");
    expect(writeActions).toHaveLength(6);
    expect(readActions).toHaveLength(12);
  });

  it("has 3 contracts", () => {
    expect(Object.keys(lidoDef.contracts)).toHaveLength(3);
  });

  it("wsteth contract is available on Mainnet, Base, and Sepolia", () => {
    const chains = Object.keys(lidoDef.contracts.wsteth.addresses);
    expect(chains).toContain("1");
    expect(chains).toContain("8453");
    expect(chains).toContain("11155111");
  });

  it("steth contract is available on Mainnet and Sepolia", () => {
    const chains = Object.keys(lidoDef.contracts.steth.addresses);
    expect(chains).toContain("1");
    expect(chains).toContain("11155111");
  });

  it("getStETHByWstETH has 1 output", () => {
    const action = lidoDef.actions.find(
      (a) => a.slug === "get-steth-by-wsteth"
    );
    expect(action).toBeDefined();
    expect(action?.outputs).toHaveLength(1);
    expect(action?.outputs?.[0]?.name).toBe("stETHAmount");
  });

  it("getWstETHByStETH has 1 output", () => {
    const action = lidoDef.actions.find(
      (a) => a.slug === "get-wsteth-by-steth"
    );
    expect(action).toBeDefined();
    expect(action?.outputs).toHaveLength(1);
    expect(action?.outputs?.[0]?.name).toBe("wstETHAmount");
  });

  it("stEthPerToken has 1 output", () => {
    const action = lidoDef.actions.find((a) => a.slug === "steth-per-token");
    expect(action).toBeDefined();
    expect(action?.outputs).toHaveLength(1);
    expect(action?.outputs?.[0]?.name).toBe("rate");
  });

  it("tokensPerStEth has 1 output", () => {
    const action = lidoDef.actions.find((a) => a.slug === "tokens-per-steth");
    expect(action).toBeDefined();
    expect(action?.outputs).toHaveLength(1);
    expect(action?.outputs?.[0]?.name).toBe("rate");
  });

  it("balanceOf actions have 1 output each", () => {
    const wstethBalance = lidoDef.actions.find(
      (a) => a.slug === "get-wsteth-balance"
    );
    const stethBalance = lidoDef.actions.find(
      (a) => a.slug === "get-steth-balance"
    );
    expect(wstethBalance?.outputs).toHaveLength(1);
    expect(stethBalance?.outputs).toHaveLength(1);
  });

  it("totalSupply has 1 output", () => {
    const action = lidoDef.actions.find(
      (a) => a.slug === "get-wsteth-total-supply"
    );
    expect(action).toBeDefined();
    expect(action?.outputs).toHaveLength(1);
    expect(action?.outputs?.[0]?.name).toBe("totalSupply");
  });

  it("has 4 events", () => {
    expect(lidoDef.events).toHaveLength(4);
  });

  it("exposes only owner-directed withdrawal claims", () => {
    expect(lidoDef.actions.map((action) => action.slug)).toContain(
      "claim-withdrawals"
    );
    expect(lidoDef.actions.map((action) => action.slug)).not.toContain(
      "claim-withdrawals-to"
    );
  });

  it("matches the Withdrawal Queue array return and indexed event ABI", () => {
    const withdrawalQueueAbi = lidoDef.contracts.withdrawalQueue.abi;
    expect(withdrawalQueueAbi).toBeDefined();
    const queueAbi = JSON.parse(withdrawalQueueAbi ?? "[]");
    const claimable = queueAbi.find(
      (entry: { name?: string }) => entry.name === "getClaimableEther"
    );
    const requested = queueAbi.find(
      (entry: { name?: string }) => entry.name === "WithdrawalRequested"
    );
    const finalized = queueAbi.find(
      (entry: { name?: string }) => entry.name === "WithdrawalsFinalized"
    );
    const claimed = queueAbi.find(
      (entry: { name?: string }) => entry.name === "WithdrawalClaimed"
    );

    expect(claimable.outputs).toEqual([
      { name: "claimableEther", type: "uint256[]" },
    ]);
    expect(requested.inputs[3]).toMatchObject({ name: "amountOfStETH" });
    expect(finalized.inputs.slice(0, 2)).toEqual([
      expect.objectContaining({ name: "from", indexed: true }),
      expect.objectContaining({ name: "to", indexed: true }),
    ]);
    expect(claimed.inputs[2]).toMatchObject({
      name: "receiver",
      indexed: true,
    });
  });

  it("describes every Withdrawal Queue output and 18-decimal claimable ETH", () => {
    const queueReads = [
      "get-withdrawal-requests",
      "get-withdrawal-status",
      "get-last-checkpoint-index",
      "find-checkpoint-hints",
      "get-claimable-ether",
    ];

    for (const slug of queueReads) {
      const action = lidoDef.actions.find(
        (candidate) => candidate.slug === slug
      );
      expect(
        action?.outputs,
        `${slug} must declare output metadata`
      ).toHaveLength(1);
    }

    const claimable = lidoDef.actions.find(
      (action) => action.slug === "get-claimable-ether"
    );
    expect(claimable?.outputs?.[0]).toMatchObject({
      name: "claimableEther",
      decimals: 18,
    });
  });

  it("targets named Withdrawal Queue results in coverage expectations", () => {
    expect(lidoDef.testData?.["1"]?.expectations).toMatchObject({
      "get-withdrawal-status": [{ field: "statuses", notEmpty: true }],
      "get-last-checkpoint-index": [
        { field: "lastCheckpointIndex", nonZero: true },
      ],
      "find-checkpoint-hints": [{ field: "hints", notEmpty: true }],
      "get-claimable-ether": [{ field: "claimableEther", notEmpty: true }],
    });
  });

  it("warns request builders about approval and owner requirements", () => {
    for (const slug of ["request-withdrawals", "request-withdrawals-wsteth"]) {
      const action = lidoDef.actions.find(
        (candidate) => candidate.slug === slug
      );
      expect(
        action?.inputs.find((input) => input.name === "amounts")?.helpTip
      ).toContain("Withdrawal Queue");
      expect(
        action?.inputs.find((input) => input.name === "owner")?.helpTip
      ).toContain("executing wallet");
    }
  });

  it("all event slugs are valid kebab-case", () => {
    for (const event of lidoDef.events ?? []) {
      expect(event.slug).toMatch(KEBAB_CASE_REGEX);
    }
  });

  it("every event references an existing contract", () => {
    const contractKeys = new Set(Object.keys(lidoDef.contracts));
    for (const event of lidoDef.events ?? []) {
      expect(
        contractKeys.has(event.contract),
        `event "${event.slug}" references unknown contract "${event.contract}"`
      ).toBe(true);
    }
  });

  it("registers in the protocol registry and is retrievable", () => {
    registerProtocol(lidoDef);
    const retrieved = getProtocol("lido");
    expect(retrieved).toBeDefined();
    expect(retrieved?.slug).toBe("lido");
    expect(retrieved?.name).toBe("Lido");
  });
});
