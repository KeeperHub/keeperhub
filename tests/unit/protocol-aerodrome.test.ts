import { describe, expect, it } from "vitest";
import { getProtocol, registerProtocol } from "@/lib/protocol-registry";
import aerodromeDef from "@/protocols/aerodrome";

const KEBAB_CASE_REGEX = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const HEX_ADDRESS_REGEX = /^0x[\dA-Fa-f]{40}$/;

describe("Aerodrome Protocol Definition", () => {
  it("imports without throwing", () => {
    expect(aerodromeDef).toBeDefined();
    expect(aerodromeDef.name).toBe("Aerodrome");
    expect(aerodromeDef.slug).toBe("aerodrome");
  });

  it("protocol slug is valid kebab-case", () => {
    expect(aerodromeDef.slug).toMatch(KEBAB_CASE_REGEX);
  });

  it("all action slugs are valid kebab-case", () => {
    for (const action of aerodromeDef.actions) {
      expect(action.slug).toMatch(KEBAB_CASE_REGEX);
    }
  });

  it("all event slugs are valid kebab-case", () => {
    for (const event of aerodromeDef.events ?? []) {
      expect(event.slug).toMatch(KEBAB_CASE_REGEX);
    }
  });

  it("all contract addresses are valid 42-character hex strings", () => {
    for (const [contractKey, contract] of Object.entries(
      aerodromeDef.contracts
    )) {
      for (const [chain, address] of Object.entries(contract.addresses)) {
        expect(address, `${contractKey} on chain ${chain}`).toMatch(
          HEX_ADDRESS_REGEX
        );
        expect(address, `${contractKey} on chain ${chain} length`).toHaveLength(
          42
        );
      }
    }
  });

  it("every action references an existing contract", () => {
    const contractKeys = new Set(Object.keys(aerodromeDef.contracts));
    for (const action of aerodromeDef.actions) {
      expect(
        contractKeys.has(action.contract),
        `action "${action.slug}" references unknown contract "${action.contract}"`
      ).toBe(true);
    }
  });

  it("every event references an existing contract", () => {
    const contractKeys = new Set(Object.keys(aerodromeDef.contracts));
    for (const event of aerodromeDef.events ?? []) {
      expect(
        contractKeys.has(event.contract),
        `event "${event.slug}" references unknown contract "${event.contract}"`
      ).toBe(true);
    }
  });

  it("has no duplicate action slugs", () => {
    const slugs = aerodromeDef.actions.map((a) => a.slug);
    const uniqueSlugs = new Set(slugs);
    expect(slugs.length).toBe(uniqueSlugs.size);
  });

  it("has no duplicate event slugs", () => {
    const slugs = (aerodromeDef.events ?? []).map((e) => e.slug);
    const uniqueSlugs = new Set(slugs);
    expect(slugs.length).toBe(uniqueSlugs.size);
  });

  it("all read actions define outputs", () => {
    const readActions = aerodromeDef.actions.filter((a) => a.type === "read");
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
    for (const action of aerodromeDef.actions) {
      const contract = aerodromeDef.contracts[action.contract];
      expect(contract).toBeDefined();
      expect(
        Object.keys(contract.addresses).length,
        `contract "${action.contract}" for action "${action.slug}" must have at least one chain`
      ).toBeGreaterThan(0);
    }
  });

  it("has 21 actions (10 read, 11 write)", () => {
    expect(aerodromeDef.actions).toHaveLength(21);
    const readActions = aerodromeDef.actions.filter((a) => a.type === "read");
    const writeActions = aerodromeDef.actions.filter((a) => a.type === "write");
    expect(readActions).toHaveLength(10);
    expect(writeActions).toHaveLength(11);
  });

  it("has 7 events", () => {
    expect(aerodromeDef.events).toHaveLength(7);
  });

  it("registers in the protocol registry and is retrievable", () => {
    registerProtocol(aerodromeDef);
    const retrieved = getProtocol("aerodrome");
    expect(retrieved).toBeDefined();
    expect(retrieved?.slug).toBe("aerodrome");
    expect(retrieved?.name).toBe("Aerodrome");
  });

  it("has 6 contracts", () => {
    expect(Object.keys(aerodromeDef.contracts)).toHaveLength(6);
  });

  it("all contracts are available on Base (chain 8453)", () => {
    for (const [key, contract] of Object.entries(aerodromeDef.contracts)) {
      expect(
        contract.addresses["8453"],
        `${key} should have Base address`
      ).toBeDefined();
    }
  });

  it("get-reserves action returns 2 output fields without hardcoded decimals", () => {
    const getReserves = aerodromeDef.actions.find(
      (a) => a.slug === "get-reserves"
    );
    expect(getReserves).toBeDefined();
    expect(getReserves?.outputs).toHaveLength(2);
    for (const output of getReserves?.outputs ?? []) {
      expect(
        output.decimals,
        "reserve outputs should not hardcode decimals"
      ).toBeUndefined();
    }
  });

  it("get-amount-out action returns 1 output field", () => {
    const getAmountOut = aerodromeDef.actions.find(
      (a) => a.slug === "get-amount-out"
    );
    expect(getAmountOut).toBeDefined();
    expect(getAmountOut?.outputs).toHaveLength(1);
  });

  it("swap action includes routes input", () => {
    const swap = aerodromeDef.actions.find(
      (a) => a.slug === "swap-exact-tokens"
    );
    expect(swap).toBeDefined();
    const routesInput = swap?.inputs.find((i) => i.name === "routes");
    expect(routesInput, "swap must have routes input").toBeDefined();
  });

  it("includes address resolution actions (poolFor, gauges)", () => {
    const poolFor = aerodromeDef.actions.find(
      (a) => a.slug === "get-pool-for-pair"
    );
    const gaugeFor = aerodromeDef.actions.find(
      (a) => a.slug === "get-gauge-for-pool"
    );
    expect(poolFor, "must have pool address resolution").toBeDefined();
    expect(gaugeFor, "must have gauge address resolution").toBeDefined();
  });

  it("includes full veNFT lifecycle actions", () => {
    const expectedSlugs = [
      "create-lock",
      "increase-lock-amount",
      "increase-lock-duration",
      "withdraw-lock",
      "get-lock-details",
    ];
    for (const slug of expectedSlugs) {
      expect(
        aerodromeDef.actions.find((a) => a.slug === slug),
        `must have veNFT action "${slug}"`
      ).toBeDefined();
    }
  });

  it("includes liquidity actions (add and remove)", () => {
    const addLiq = aerodromeDef.actions.find((a) => a.slug === "add-liquidity");
    const removeLiq = aerodromeDef.actions.find(
      (a) => a.slug === "remove-liquidity"
    );
    expect(addLiq, "must have add liquidity").toBeDefined();
    expect(removeLiq, "must have remove liquidity").toBeDefined();
  });
});
