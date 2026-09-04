import { describe, expect, it } from "vitest";
import {
  Capability,
  FactProvenance,
  FactState,
  PolicyCheckpoint,
  PolicyRole,
  PrincipalKind,
} from "@/lib/policy";
import { compilePolicy } from "@/lib/policy/compile";
import { evaluatePolicy } from "@/lib/policy/engine";
import type {
  CompiledPolicySet,
  PolicyDocument,
  PolicyFacts,
  Principal,
} from "@/lib/policy/types";

/**
 * Conditions on list-backed facts.
 *
 * `assets` and `counterparties` resolve to several strings, because one asset
 * offers both its address and its symbol. Comparing the list itself stringifies
 * it to a comma-joined value that matches nothing, which turned every asset and
 * counterparty rule into a no-op: an allow then granted nothing, and a deny
 * refused nothing. The deny half is why this is a security test and not a
 * usability one.
 */

const ORG = "org-list-facts";
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const WETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
const TREASURY = "0x1111111111111111111111111111111111111111";
const STRANGER = "0x2222222222222222222222222222222222222222";

const UNKNOWN = { state: FactState.UNKNOWN } as const;
const known = (value: unknown) => ({
  state: FactState.KNOWN,
  value,
  provenance: FactProvenance.AUTHORITATIVE,
});

function facts(over: Record<string, unknown>): PolicyFacts {
  return {
    capability: Capability.ASSET_TRANSFER_TOKEN,
    resource: UNKNOWN,
    chainId: UNKNOWN,
    contractAddress: UNKNOWN,
    selector: UNKNOWN,
    protocolSlug: UNKNOWN,
    assets: UNKNOWN,
    counterparties: UNKNOWN,
    nativeValueWei: UNKNOWN,
    usdValue: UNKNOWN,
    unbounded: UNKNOWN,
    gasPriceGwei: UNKNOWN,
    gasLimit: UNKNOWN,
    signerMode: UNKNOWN,
    triggerType: UNKNOWN,
    workflowId: UNKNOWN,
    workflowTags: UNKNOWN,
    projectId: UNKNOWN,
    sourceIp: UNKNOWN,
    httpHost: UNKNOWN,
    httpUrl: UNKNOWN,
    httpMethod: UNKNOWN,
    resourceId: UNKNOWN,
    ...over,
  } as PolicyFacts;
}

const OWNER: Principal = {
  kind: PrincipalKind.MEMBER,
  userId: "u1",
  organizationId: ORG,
  role: PolicyRole.OWNER,
};

function decide(document: PolicyDocument, over: Record<string, unknown>) {
  const compiled = compilePolicy({
    id: document.name,
    enabled: true,
    document,
    enforcement: document.enforcement,
  });
  if (!compiled.ok) {
    throw new Error(compiled.errors.map((e) => e.message).join("; "));
  }
  return evaluatePolicy(
    {
      principal: OWNER,
      organizationId: ORG,
      capability: Capability.ASSET_TRANSFER_TOKEN,
      facts: facts(over),
      checkpoint: PolicyCheckpoint.NODE,
    },
    {
      organizationId: ORG,
      version: "test",
      policies: [compiled.compiled],
      compiledAt: Date.now(),
    } as CompiledPolicySet
  );
}

const asset = (address: string, symbol: string) =>
  known([{ address, symbol, amount: "1", usdValue: "10" }]);
const recipient = (address: string) => known([{ address, role: "recipient" }]);

const denyAsset = {
  schemaVersion: "2026-08",
  name: "asset deny",
  enforcement: "enforce",
  manages: ["asset.transfer.**"],
  statements: [
    {
      sid: "frozen",
      effect: "deny",
      capability: [Capability.ASSET_TRANSFER_TOKEN],
      condition: { asset: { in: [WETH] } },
    },
  ],
} as unknown as PolicyDocument;

describe("conditions on list-backed facts", () => {
  it("fires a deny when the named asset is the one moving", () => {
    const decision = decide(denyAsset, { assets: asset(WETH, "WETH") });
    expect(decision.outcome).toBe("deny");
    expect(decision.matched.map((m) => m.sid)).toContain("frozen");
  });

  it("leaves a different asset alone", () => {
    const decision = decide(denyAsset, { assets: asset(USDC, "USDC") });
    expect(decision.matched.map((m) => m.sid)).not.toContain("frozen");
  });

  it("matches an asset by symbol as well as by address", () => {
    const bySymbol = {
      ...denyAsset,
      statements: [
        {
          sid: "frozen",
          effect: "deny",
          capability: [Capability.ASSET_TRANSFER_TOKEN],
          condition: { asset: { in: ["WETH"] } },
        },
      ],
    } as unknown as PolicyDocument;
    const decision = decide(bySymbol, { assets: asset(WETH, "WETH") });
    expect(decision.outcome).toBe("deny");
  });

  it("grants an allow when the asset is on the allowlist", () => {
    const allowlist = {
      schemaVersion: "2026-08",
      name: "asset allow",
      enforcement: "enforce",
      manages: ["asset.transfer.**"],
      statements: [
        {
          sid: "approved",
          effect: "allow",
          capability: [Capability.ASSET_TRANSFER_TOKEN],
          condition: { asset: { in: [USDC] } },
        },
      ],
    } as unknown as PolicyDocument;
    expect(decide(allowlist, { assets: asset(USDC, "USDC") }).outcome).toBe(
      "allow"
    );
    expect(decide(allowlist, { assets: asset(WETH, "WETH") }).outcome).toBe(
      "deny"
    );
  });

  it("refuses a counterparty outside the allowlist, and only that one", () => {
    const document = {
      schemaVersion: "2026-08",
      name: "counterparty deny",
      enforcement: "enforce",
      manages: ["asset.transfer.**"],
      statements: [
        {
          sid: "strangers",
          effect: "deny",
          capability: [Capability.ASSET_TRANSFER_TOKEN],
          condition: { counterparty: { notIn: [TREASURY] } },
        },
      ],
    } as unknown as PolicyDocument;

    expect(
      decide(document, { counterparties: recipient(STRANGER) }).outcome
    ).toBe("deny");
    expect(
      decide(document, { counterparties: recipient(TREASURY) }).matched
    ).toHaveLength(0);
  });
});
