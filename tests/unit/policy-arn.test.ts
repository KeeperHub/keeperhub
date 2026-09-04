import { describe, expect, it } from "vitest";

import {
  ARN_SELECTOR_NONE,
  ArnSegment,
  arnStringMatches,
  buildAssetArn,
  buildContractCallArn,
  buildResourceArn,
  isConcreteArn,
  isValidAddress,
  isValidSelector,
  parseArn,
} from "@/lib/policy";

const AAVE_POOL = "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5";
const SUPPLY_SELECTOR = "0x617ba037";

describe("parseArn", () => {
  it("parses the canonical contract-call form", () => {
    const result = parseArn(
      `kh:chain/8453/contract/${AAVE_POOL.toLowerCase()}/fn/${SUPPLY_SELECTOR}`
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.arn.parts).toEqual([
      { type: ArnSegment.CHAIN, id: "8453" },
      { type: ArnSegment.CONTRACT, id: AAVE_POOL.toLowerCase() },
      { type: ArnSegment.FUNCTION, id: SUPPLY_SELECTOR },
    ]);
  });

  it("lowercases addresses so matching needs no case handling", () => {
    const result = parseArn(`kh:chain/1/contract/${AAVE_POOL}`);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.arn.parts[1]?.id).toBe(AAVE_POOL.toLowerCase());
    expect(result.arn.value).toContain(AAVE_POOL.toLowerCase());
  });

  it("rejects an unknown segment type rather than ignoring it", () => {
    const result = parseArn("kh:galaxy/andromeda");
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toContain("galaxy");
  });

  it("rejects an unpaired segment", () => {
    const result = parseArn("kh:chain/8453/contract");
    expect(result.ok).toBe(false);
  });

  it("rejects a missing or wrong prefix", () => {
    expect(parseArn("chain/8453").ok).toBe(false);
    expect(parseArn("aws:chain/8453").ok).toBe(false);
    expect(parseArn("   ").ok).toBe(false);
  });

  it("accepts a trailing deep wildcard", () => {
    expect(parseArn("kh:chain/8453/**").ok).toBe(true);
  });
});

describe("arn builders", () => {
  it("builds the canonical contract-call form", () => {
    expect(
      buildContractCallArn({
        chainId: 8453,
        contractAddress: AAVE_POOL,
        selector: SUPPLY_SELECTOR,
      })
    ).toBe(
      `kh:chain/8453/contract/${AAVE_POOL.toLowerCase()}/fn/${SUPPLY_SELECTOR}`
    );
  });

  it("uses the sentinel when there is no calldata", () => {
    expect(
      buildContractCallArn({
        chainId: 1,
        contractAddress: AAVE_POOL,
        selector: null,
      })
    ).toBe(
      `kh:chain/1/contract/${AAVE_POOL.toLowerCase()}/fn/${ARN_SELECTOR_NONE}`
    );
  });

  it("builds asset and flat control-plane identifiers", () => {
    expect(buildAssetArn({ chainId: 8453, tokenAddress: AAVE_POOL })).toBe(
      `kh:chain/8453/asset/${AAVE_POOL.toLowerCase()}`
    );
    expect(buildResourceArn(ArnSegment.WORKFLOW, "wf_7f3a")).toBe(
      "kh:workflow/wf_7f3a"
    );
  });
});

describe("arnStringMatches", () => {
  const target = `kh:chain/8453/contract/${AAVE_POOL.toLowerCase()}/fn/${SUPPLY_SELECTOR}`;

  it("matches an exact identifier", () => {
    expect(arnStringMatches(target, target)).toBe(true);
  });

  it("matches a single-segment wildcard on the selector", () => {
    expect(
      arnStringMatches(
        `kh:chain/8453/contract/${AAVE_POOL.toLowerCase()}/fn/*`,
        target
      )
    ).toBe(true);
  });

  it("matches a deep wildcard at any depth", () => {
    expect(arnStringMatches("kh:chain/8453/**", target)).toBe(true);
    expect(
      arnStringMatches(
        `kh:chain/8453/contract/${AAVE_POOL.toLowerCase()}/**`,
        target
      )
    ).toBe(true);
  });

  it("matches a wildcard chain", () => {
    expect(
      arnStringMatches(
        `kh:chain/*/contract/${AAVE_POOL.toLowerCase()}/fn/${SUPPLY_SELECTOR}`,
        target
      )
    ).toBe(true);
  });

  it("does NOT let a shorter prefix cover a deeper target without a deep wildcard", () => {
    // Containment must be explicit, or every chain-level rule would silently
    // grant every contract call on that chain.
    expect(arnStringMatches("kh:chain/8453", target)).toBe(false);
    expect(
      arnStringMatches(
        `kh:chain/8453/contract/${AAVE_POOL.toLowerCase()}`,
        target
      )
    ).toBe(false);
  });

  it("does not match a different selector", () => {
    expect(
      arnStringMatches(
        `kh:chain/8453/contract/${AAVE_POOL.toLowerCase()}/fn/0xdeadbeef`,
        target
      )
    ).toBe(false);
  });

  it("does not match a different chain", () => {
    expect(
      arnStringMatches(
        `kh:chain/1/contract/${AAVE_POOL.toLowerCase()}/fn/${SUPPLY_SELECTOR}`,
        target
      )
    ).toBe(false);
  });

  it("is case-insensitive on addresses via normalization", () => {
    expect(
      arnStringMatches(
        `kh:chain/8453/contract/${AAVE_POOL}/fn/${SUPPLY_SELECTOR}`,
        target
      )
    ).toBe(true);
  });

  it("never matches when either side is malformed", () => {
    expect(arnStringMatches("kh:galaxy/andromeda", target)).toBe(false);
    expect(arnStringMatches(target, "not-an-arn")).toBe(false);
  });
});

describe("isConcreteArn", () => {
  it("treats chain/contract/fn identifiers as concrete", () => {
    const parsed = parseArn(
      `kh:chain/8453/contract/${AAVE_POOL.toLowerCase()}/fn/${SUPPLY_SELECTOR}`
    );
    expect(parsed.ok && isConcreteArn(parsed.arn)).toBe(true);
  });

  it("treats ontology classes as abstract, needing expansion", () => {
    const protocol = parseArn("kh:protocol/aave-v3/contract/pool");
    expect(protocol.ok && isConcreteArn(protocol.arn)).toBe(false);

    const assetClass = parseArn("kh:asset/class/stablecoin");
    expect(assetClass.ok && isConcreteArn(assetClass.arn)).toBe(false);
  });
});

describe("selector and address validation", () => {
  it("accepts a four-byte selector and the no-calldata sentinel", () => {
    expect(isValidSelector(SUPPLY_SELECTOR)).toBe(true);
    expect(isValidSelector(ARN_SELECTOR_NONE)).toBe(true);
  });

  it("rejects a signature string, which is the whole point of selector keying", () => {
    expect(isValidSelector("supply(address,uint256,address,uint16)")).toBe(
      false
    );
    expect(isValidSelector("0x617ba0")).toBe(false);
  });

  it("validates addresses in normalized lowercase form", () => {
    expect(isValidAddress(AAVE_POOL.toLowerCase())).toBe(true);
    expect(isValidAddress("0x123")).toBe(false);
  });
});
