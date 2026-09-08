/**
 * Wave 0 RED scaffold for lib/agentic-wallet/policy.ts.
 *
 * Contract anchor: 33-RESEARCH.md Pattern 2 (lines 301-364) and
 * 33-CONTEXT.md Resolution #2 (lines 126-127).
 *
 * The three baseline Turnkey policies are non-negotiable per GUARD-06 and
 * must be applied at provision time. This scaffold pins the literal policy
 * names, condition substrings, effect = "EFFECT_DENY", and the Base + Tempo
 * USDC addresses into the allowlist so Wave 1+ cannot silently water them
 * down. Baseline: every assertion fails because BASELINE_POLICIES is an
 * empty stub array. Plan 33-01a flips this suite GREEN.
 */
import { describe, expect, it, vi } from "vitest";
import {
  applyBaselinePolicies,
  BASELINE_POLICIES,
  FACILITATOR_ALLOWLIST,
  PolicyIncompleteError,
} from "@/lib/agentic-wallet/policy";

describe("BASELINE_POLICIES", () => {
  it("contains exactly 8 entries (5 eth.tx.* + 3 eth.eip_712.*)", () => {
    // 3 original eth.tx.* policies (block-erc20-approve, block-erc20-transfer,
    // allowlist-outbound) + 2 new ERC-8004 eth.tx.* policies (chain-binding,
    // selector) + 3 original eth.eip_712.* policies = 8.
    expect(BASELINE_POLICIES.length).toBe(8);
  });

  it("entry 0 blocks ERC-20 approvals over 100 USDC (selector 0x095ea7b3)", () => {
    const p = BASELINE_POLICIES[0];
    expect(p).toBeDefined();
    expect(p?.policyName).toBe("block-erc20-unlimited-approve");
    expect(p?.effect).toBe("EFFECT_DENY");
    // Phase 37 fix #8: threshold is now > 100 USDC (100_000_000), not 2^32.
    expect(p?.condition).toContain("0x095ea7b3");
    expect(p?.condition).toContain("100000000");
  });

  it("entry 1 caps transfer / transferFrom at 100 USDC (6 decimals)", () => {
    const p = BASELINE_POLICIES[1];
    expect(p).toBeDefined();
    // 0xa9059cbb = transfer(address,uint256); 0x23b872dd = transferFrom
    expect(p?.condition).toContain("0xa9059cbb");
    expect(p?.condition).toContain("0x23b872dd");
    // 100 USDC in 6 decimals = 100_000_000.
    expect(p?.condition).toContain("100000000");
    expect(p?.effect).toBe("EFFECT_DENY");
  });

  it("entry 2 enforces the outbound contract allowlist", () => {
    const p = BASELINE_POLICIES[2];
    expect(p).toBeDefined();
    // The Turnkey DSL uses `x in [...]` for membership; the inverse is
    // the deny rule. Either substring is acceptable.
    const cond = p?.condition ?? "";
    const hasAllowlistClause =
      cond.includes("eth.tx.to in [") || cond.includes("!(eth.tx.to in [");
    expect(hasAllowlistClause).toBe(true);
    // References at least one address from FACILITATOR_ALLOWLIST.
    const anyKnown = FACILITATOR_ALLOWLIST.some((addr) =>
      cond.toLowerCase().includes(addr.toLowerCase())
    );
    expect(anyKnown).toBe(true);
    expect(p?.effect).toBe("EFFECT_DENY");
  });

  it("BaselinePolicy type does not carry a consensus field (set at createPolicy call site)", () => {
    for (const p of BASELINE_POLICIES) {
      const hasConsensus = "consensus" in (p as Record<string, unknown>);
      expect(hasConsensus).toBe(false);
    }
  });

  it("all baseline policy names are unique (Turnkey enforces uniqueness)", () => {
    const names = new Set(BASELINE_POLICIES.map((p) => p.policyName));
    expect(names.size).toBe(BASELINE_POLICIES.length);
  });
});

describe("FACILITATOR_ALLOWLIST", () => {
  it("includes the Base USDC contract (CONTEXT Resolution #2)", () => {
    expect(FACILITATOR_ALLOWLIST).toContain(
      "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
    );
  });

  it("includes the Tempo USDC contract (CONTEXT Resolution #2)", () => {
    expect(FACILITATOR_ALLOWLIST).toContain(
      "0x20c000000000000000000000b9537d11c60e8b50"
    );
  });

  it("is exported as a readonly array (compile-time const-assertion check)", () => {
    // A `readonly string[]` still supports `.includes` / `.length` checks.
    expect(Array.isArray(FACILITATOR_ALLOWLIST)).toBe(true);
    expect(FACILITATOR_ALLOWLIST.length).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// REVIEW HI-04: applyBaselinePolicies partial-failure + post-condition tests.
// These lock the GUARD-06 invariant "Turnkey policy is the ONLY hard limit"
// by proving that ANY incomplete application rolls back and throws
// PolicyIncompleteError, and that listPolicies is consulted as a
// post-condition.
// ---------------------------------------------------------------------------

type PolicyCreateInput = {
  organizationId: string;
  policyName: string;
  effect: string;
  condition: string;
  consensus: string;
  notes: string;
};

type PolicyCreateResult = {
  activity: { id: string; status: string };
  policyId: string;
};

type PolicyDeleteInput = {
  organizationId: string;
  policyId: string;
};

type PolicyListResult = {
  policies: { policyName: string; effect: string }[];
};

type StubClient = {
  createPolicy: ReturnType<typeof vi.fn>;
  deletePolicy: ReturnType<typeof vi.fn>;
  getPolicies: ReturnType<typeof vi.fn>;
};

function makeClient(): StubClient {
  return {
    createPolicy: vi.fn(),
    deletePolicy: vi.fn(),
    getPolicies: vi.fn(),
  };
}

describe("applyBaselinePolicies (HI-04)", () => {
  const SUB_ORG = "subOrg_policy_test";

  it("happy path: creates all baseline policies then verifies via getPolicies", async () => {
    const client = makeClient();
    let counter = 0;
    client.createPolicy.mockImplementation(
      async (_input: PolicyCreateInput): Promise<PolicyCreateResult> => {
        counter += 1;
        return {
          activity: {
            id: `act_${counter}`,
            status: "ACTIVITY_STATUS_COMPLETED",
          },
          policyId: `policy_${counter}`,
        };
      }
    );
    client.getPolicies.mockResolvedValue({
      policies: BASELINE_POLICIES.map((p) => ({
        policyName: p.policyName,
        effect: p.effect,
      })),
    } satisfies PolicyListResult);

    // Cast to the concrete ApiClient shape -- the helper only touches the
    // three methods the stub provides.
    await applyBaselinePolicies(
      client as unknown as Parameters<typeof applyBaselinePolicies>[0],
      SUB_ORG
    );

    expect(client.createPolicy).toHaveBeenCalledTimes(BASELINE_POLICIES.length);
    expect(client.getPolicies).toHaveBeenCalledTimes(1);
    expect(client.deletePolicy).not.toHaveBeenCalled();
  });

  it("rolls back partial successes and throws PolicyIncompleteError on any failure", async () => {
    const client = makeClient();
    // All but the last succeed; the last rejects.
    const lastIdx = BASELINE_POLICIES.length - 1;
    const lastPolicy = BASELINE_POLICIES[lastIdx];
    const created: string[] = [];
    client.createPolicy.mockImplementation(
      async (input: PolicyCreateInput): Promise<PolicyCreateResult> => {
        if (input.policyName === lastPolicy?.policyName) {
          throw new Error("Turnkey 5xx");
        }
        const id = `policy_${created.length + 1}`;
        created.push(id);
        return {
          activity: { id: `act_${id}`, status: "ACTIVITY_STATUS_COMPLETED" },
          policyId: id,
        };
      }
    );

    await expect(
      applyBaselinePolicies(
        client as unknown as Parameters<typeof applyBaselinePolicies>[0],
        SUB_ORG
      )
    ).rejects.toBeInstanceOf(PolicyIncompleteError);

    // getPolicies MUST NOT be queried on the failure path -- we fail fast.
    expect(client.getPolicies).not.toHaveBeenCalled();

    // N-1 successful creates -> N-1 rollback delete calls.
    const expectedSuccesses = BASELINE_POLICIES.length - 1;
    expect(client.deletePolicy).toHaveBeenCalledTimes(expectedSuccesses);
    const deleteCalls = client.deletePolicy.mock.calls as unknown as [
      PolicyDeleteInput,
    ][];
    const deletedIds = deleteCalls.map((c) => c[0].policyId).sort();
    const expectedIds = Array.from(
      { length: expectedSuccesses },
      (_, i) => `policy_${i + 1}`
    ).sort();
    expect(deletedIds).toEqual(expectedIds);
  });

  it("PolicyIncompleteError carries the list of failing policyNames", async () => {
    const client = makeClient();
    client.createPolicy.mockImplementation(
      async (input: PolicyCreateInput): Promise<PolicyCreateResult> => {
        if (input.policyName === BASELINE_POLICIES[1].policyName) {
          throw new Error("network timeout");
        }
        return {
          activity: { id: "act", status: "ACTIVITY_STATUS_COMPLETED" },
          policyId: `policy_${input.policyName}`,
        };
      }
    );

    try {
      await applyBaselinePolicies(
        client as unknown as Parameters<typeof applyBaselinePolicies>[0],
        SUB_ORG
      );
      throw new Error("expected PolicyIncompleteError");
    } catch (err) {
      expect(err).toBeInstanceOf(PolicyIncompleteError);
      const pie = err as PolicyIncompleteError;
      expect(pie.subOrgId).toBe(SUB_ORG);
      expect(pie.failures).toEqual([BASELINE_POLICIES[1].policyName]);
    }
  });

  it("post-condition: throws PolicyIncompleteError if getPolicies is missing a baseline policy", async () => {
    const client = makeClient();
    let counter = 0;
    client.createPolicy.mockImplementation(
      async (_input: PolicyCreateInput): Promise<PolicyCreateResult> => {
        counter += 1;
        return {
          activity: {
            id: `act_${counter}`,
            status: "ACTIVITY_STATUS_COMPLETED",
          },
          policyId: `policy_${counter}`,
        };
      }
    );
    // getPolicies reports only N-1 of the N baseline rules (drop the last).
    client.getPolicies.mockResolvedValue({
      policies: BASELINE_POLICIES.slice(0, -1).map((p) => ({
        policyName: p.policyName,
        effect: p.effect,
      })),
    } satisfies PolicyListResult);

    await expect(
      applyBaselinePolicies(
        client as unknown as Parameters<typeof applyBaselinePolicies>[0],
        SUB_ORG
      )
    ).rejects.toBeInstanceOf(PolicyIncompleteError);

    // Post-condition failure ALSO rolls back the successful creates so the
    // sub-org ends up unprotected (no partial coverage).
    expect(client.deletePolicy).toHaveBeenCalledTimes(BASELINE_POLICIES.length);
  });
});

describe("BASELINE_POLICIES — EIP-712 coverage (Phase 37)", () => {
  it("contains 8 entries (5 eth.tx.* + 3 eth.eip_712.*)", () => {
    expect(BASELINE_POLICIES.length).toBe(8);
  });

  it("block-erc20-unlimited-approve threshold is > 100 USDC, not 2^32", () => {
    const p = BASELINE_POLICIES.find(
      (x) => x.policyName === "block-erc20-unlimited-approve"
    );
    expect(p?.condition).toContain("100000000");
    expect(p?.condition).not.toContain("4294967296");
  });

  it("includes block-eip712-foreign-domain", () => {
    const p = BASELINE_POLICIES.find(
      (x) => x.policyName === "block-eip712-foreign-domain"
    );
    expect(p).toBeDefined();
    // Corrected field name: verifying_contract (snake_case) not verifyingContract.
    // activity.parameters.encoding removed — field does not exist in Turnkey DSL.
    expect(p?.condition).toContain("eth.eip_712.domain.verifying_contract");
    expect(p?.condition).not.toContain("activity.parameters.encoding");
  });

  it("includes block-eip712-erc3009-overcap", () => {
    const p = BASELINE_POLICIES.find(
      (x) => x.policyName === "block-eip712-erc3009-overcap"
    );
    expect(p).toBeDefined();
    expect(p?.condition).toContain("TransferWithAuthorization");
    // Corrected: bracket notation message['value'] not dot-access message.value.
    expect(p?.condition).toContain("eth.eip_712.message['value']");
    expect(p?.condition).toContain("100000000");
  });

  it("includes block-eip712-foreign-chainid", () => {
    const p = BASELINE_POLICIES.find(
      (x) => x.policyName === "block-eip712-foreign-chainid"
    );
    expect(p).toBeDefined();
    // Corrected field name: chain_id (snake_case) not chainId.
    // Integer `in [...]` unsupported for numeric fields; expanded to `== x || == y` form.
    // Includes Tempo testnet (4218) to match ALLOWED_TEMPO_CHAIN_IDS.
    expect(p?.condition).toContain("eth.eip_712.domain.chain_id");
    expect(p?.condition).toContain("8453");
    expect(p?.condition).toContain("4217");
    expect(p?.condition).toContain("4218");
  });
});

// ---------------------------------------------------------------------------
// ERC-8004 (2026-05): the outbound contract allowlist now includes the
// ReputationRegistry on Ethereum mainnet for giveFeedback() calls. Two new
// policies bind contracts to chains and restrict ReputationRegistry to a
// single function selector.
// ---------------------------------------------------------------------------

const ERC_8004_REPUTATION_REGISTRY_LC =
  "0x8004baa17c55a88189ae136b182e5fda19de9b63";
const GIVE_FEEDBACK_SELECTOR = "0x3c036a7e";

describe("BASELINE_POLICIES — ERC-8004 coverage", () => {
  it("allowlist-outbound-contracts includes the ReputationRegistry", () => {
    const p = BASELINE_POLICIES.find(
      (x) => x.policyName === "allowlist-outbound-contracts"
    );
    expect(p).toBeDefined();
    expect(p?.condition.toLowerCase()).toContain(
      ERC_8004_REPUTATION_REGISTRY_LC
    );
  });

  it("includes allowlist-tx-chain-binding gating signTransaction", () => {
    const p = BASELINE_POLICIES.find(
      (x) => x.policyName === "allowlist-tx-chain-binding"
    );
    expect(p).toBeDefined();
    expect(p?.condition).toContain("ACTIVITY_TYPE_SIGN_TRANSACTION_V2");
    // Each contract bound to its native chain id.
    expect(p?.condition).toContain("8453"); // Base mainnet for USDC_BASE
    expect(p?.condition).toContain("4217"); // Tempo mainnet for USDC_TEMPO
    expect(p?.condition).toContain("4218"); // Tempo testnet for USDC_TEMPO
    // Ethereum mainnet (chain id 1) for the ReputationRegistry.
    expect(p?.condition).toContain("eth.tx.chain_id == 1");
    expect(p?.condition.toLowerCase()).toContain(
      ERC_8004_REPUTATION_REGISTRY_LC
    );
    expect(p?.effect).toBe("EFFECT_DENY");
  });

  it("includes allowlist-erc8004-selector restricting to giveFeedback()", () => {
    const p = BASELINE_POLICIES.find(
      (x) => x.policyName === "allowlist-erc8004-selector"
    );
    expect(p).toBeDefined();
    expect(p?.condition.toLowerCase()).toContain(
      ERC_8004_REPUTATION_REGISTRY_LC
    );
    expect(p?.condition).toContain(GIVE_FEEDBACK_SELECTOR);
    // Inverted match: the policy DENIES if function_signature != giveFeedback.
    expect(p?.condition).toContain("function_signature !=");
    expect(p?.effect).toBe("EFFECT_DENY");
  });
});

describe("FACILITATOR_ALLOWLIST — ERC-8004", () => {
  it("includes the ReputationRegistry contract", () => {
    expect(FACILITATOR_ALLOWLIST.map((a) => a.toLowerCase())).toContain(
      ERC_8004_REPUTATION_REGISTRY_LC
    );
  });
});
