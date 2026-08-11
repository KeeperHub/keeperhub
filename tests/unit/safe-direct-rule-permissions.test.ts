import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  buildDirectRulePermission,
  type DirectRuleInput,
  directRuleSelector,
  SUBGRAPH_OUTAGE_UPDATE_ERROR,
  shouldBailOnSubgraphOutage,
} from "@/lib/safe/roles-orchestrator";

const COUNTERPARTY = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const TOKEN = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"; // USDC mainnet
const ALLOWANCE_KEY =
  "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const;

const ERC20_TRANSFER_SELECTOR = "0xa9059cbb";
const ERC20_APPROVE_SELECTOR = "0x095ea7b3";

describe("directRuleSelector", () => {
  it("returns the transfer selector for erc20-transfer", () => {
    expect(directRuleSelector("erc20-transfer")).toBe(ERC20_TRANSFER_SELECTOR);
  });

  it("returns the approve selector for erc20-approve", () => {
    expect(directRuleSelector("erc20-approve")).toBe(ERC20_APPROVE_SELECTOR);
  });

  it("returns null for native-transfer (no selector)", () => {
    expect(directRuleSelector("native-transfer")).toBeNull();
  });
});

describe("buildDirectRulePermission", () => {
  function transferRule(): DirectRuleInput {
    return {
      kind: "erc20-transfer",
      tokenAddress: TOKEN,
      tokenSymbol: "USDC",
      tokenDecimals: 6,
      counterparty: COUNTERPARTY,
      amountHuman: "100",
      periodSeconds: 86_400,
    };
  }

  function approveRule(): DirectRuleInput {
    return {
      kind: "erc20-approve",
      tokenAddress: TOKEN,
      tokenSymbol: "USDC",
      tokenDecimals: 6,
      counterparty: COUNTERPARTY,
      amountHuman: "50",
      periodSeconds: 604_800,
    };
  }

  function nativeRule(): DirectRuleInput {
    return {
      kind: "native-transfer",
      tokenAddress: null,
      tokenSymbol: "ETH",
      tokenDecimals: 18,
      counterparty: COUNTERPARTY,
      amountHuman: "0.5",
      periodSeconds: 86_400,
    };
  }

  it("builds a FunctionPermission scoped to the token contract for transfer", () => {
    const permission = buildDirectRulePermission(transferRule(), ALLOWANCE_KEY);
    expect(permission).not.toBeNull();
    const checked = permission as unknown as Record<string, unknown>;
    expect(checked.targetAddress).toBe(TOKEN);
    expect(checked.signature).toBe("transfer(address,uint256)");
    expect(checked.condition).toBeDefined();
    expect(checked.send).toBe(false);
    expect(checked.delegatecall).toBe(false);
  });

  it("builds a FunctionPermission scoped to the token contract for approve", () => {
    const permission = buildDirectRulePermission(approveRule(), ALLOWANCE_KEY);
    expect(permission).not.toBeNull();
    const checked = permission as unknown as Record<string, unknown>;
    expect(checked.targetAddress).toBe(TOKEN);
    expect(checked.signature).toBe("approve(address,uint256)");
    expect(checked.condition).toBeDefined();
    expect(checked.send).toBe(false);
  });

  it("builds a TargetPermission with send=true for native transfer", () => {
    const permission = buildDirectRulePermission(nativeRule(), null);
    expect(permission).not.toBeNull();
    const checked = permission as unknown as Record<string, unknown>;
    expect(checked.targetAddress).toBe(COUNTERPARTY);
    expect(checked.send).toBe(true);
    expect(checked.delegatecall).toBe(false);
    // Native rules are target-only: no signature, no selector, no condition.
    expect(checked.signature).toBeUndefined();
    expect(checked.selector).toBeUndefined();
    expect(checked.condition).toBeUndefined();
  });

  it("attaches etherWithinAllowance when a native rule has an allowance key", () => {
    // Regression for review #923-r1 (HIGH): native rules at the install site
    // used to short-circuit to allowanceKey=null, leaving the modifier with a
    // target-only permission and the value cap unenforced. Once the install
    // path passes a real key in, this branch must wire it onto the
    // permission so EtherWithinAllowance gates each send.
    const permission = buildDirectRulePermission(nativeRule(), ALLOWANCE_KEY);
    expect(permission).not.toBeNull();
    const checked = permission as unknown as Record<string, unknown>;
    expect(checked.targetAddress).toBe(COUNTERPARTY);
    expect(checked.send).toBe(true);
    expect(checked.delegatecall).toBe(false);
    expect(checked.etherWithinAllowance).toBe(ALLOWANCE_KEY);
  });

  it("returns null for an erc20 rule missing an allowance key", () => {
    expect(buildDirectRulePermission(transferRule(), null)).toBeNull();
    expect(buildDirectRulePermission(approveRule(), null)).toBeNull();
  });

  it("returns null for an erc20 rule missing a token address", () => {
    const broken: DirectRuleInput = { ...transferRule(), tokenAddress: null };
    expect(buildDirectRulePermission(broken, ALLOWANCE_KEY)).toBeNull();
  });

  it("returns null for a malformed counterparty", () => {
    const broken: DirectRuleInput = {
      ...transferRule(),
      counterparty: "not-an-address",
    };
    expect(buildDirectRulePermission(broken, ALLOWANCE_KEY)).toBeNull();
  });

  it("checksums the counterparty address", () => {
    const lowercase: DirectRuleInput = {
      ...transferRule(),
      counterparty: COUNTERPARTY.toLowerCase(),
    };
    const permission = buildDirectRulePermission(lowercase, ALLOWANCE_KEY);
    expect(permission).not.toBeNull();
    // The native-transfer branch puts the counterparty on `targetAddress`;
    // for ERC-20 the target is the token contract, but the counterparty
    // still gets checksummed before being baked into the condition. We
    // assert the path for native to keep this simple.
    const native = buildDirectRulePermission(
      { ...nativeRule(), counterparty: COUNTERPARTY.toLowerCase() },
      null
    ) as unknown as Record<string, unknown>;
    expect(native.targetAddress).toBe(COUNTERPARTY);
  });
});

describe("shouldBailOnSubgraphOutage", () => {
  // Regression for review #923-r2 (HIGH): updateRolesConfig must refuse
  // to proceed when the Zodiac subgraph couldn't confirm chain state AND
  // the diff would touch direct rules. The only safe-to-proceed case is
  // "no direct rules existed in DB AND none were submitted in the input".

  it("bails when DB has existing direct rules", () => {
    expect(
      shouldBailOnSubgraphOutage({
        existingDirectRulesCount: 3,
        desiredDirectRulesCount: 0,
      })
    ).toBe(true);
  });

  it("bails when input submits direct rules", () => {
    expect(
      shouldBailOnSubgraphOutage({
        existingDirectRulesCount: 0,
        desiredDirectRulesCount: 2,
      })
    ).toBe(true);
  });

  it("bails when both sides have direct rules", () => {
    expect(
      shouldBailOnSubgraphOutage({
        existingDirectRulesCount: 5,
        desiredDirectRulesCount: 4,
      })
    ).toBe(true);
  });

  it("proceeds only when neither side has direct rules", () => {
    expect(
      shouldBailOnSubgraphOutage({
        existingDirectRulesCount: 0,
        desiredDirectRulesCount: 0,
      })
    ).toBe(false);
  });

  it("exposes a stable error message constant", () => {
    expect(SUBGRAPH_OUTAGE_UPDATE_ERROR).toContain("subgraph");
    expect(SUBGRAPH_OUTAGE_UPDATE_ERROR).toContain("Retry");
    expect(SUBGRAPH_OUTAGE_UPDATE_ERROR).toContain("refused");
  });
});
