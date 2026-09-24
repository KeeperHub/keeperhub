import { describe, expect, it } from "vitest";
import {
  ARN_SELECTOR_NONE,
  arnStringMatches,
  POLICY_SCHEMA_VERSION,
  PolicyEffect,
  parseArn,
} from "@/lib/policy";
import {
  deriveContractCatalog,
  draftCapabilities,
  draftManagedScopes,
  draftResources,
  fromStatement,
  type StatementDraft,
  StatementTarget,
  toStatement,
  unrepresentable,
} from "@/lib/policy/catalog";
import type { PolicyDocument, PolicyStatement } from "@/lib/policy/types";

const POOL = "0xA238dd80C259a72e81d7e4664a9801593F98d1c5";
const CONTRACT_ARN = `kh:chain/8453/contract/${POOL.toLowerCase()}`;

const ABI = [
  {
    type: "function",
    name: "supply",
    stateMutability: "nonpayable",
    inputs: [
      { name: "asset", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "onBehalfOf", type: "address" },
      { name: "referralCode", type: "uint16" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "borrow",
    stateMutability: "nonpayable",
    inputs: [
      { name: "asset", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "maxDeposit",
    stateMutability: "view",
    inputs: [{ name: "receiver", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "multicall",
    stateMutability: "payable",
    inputs: [{ name: "data", type: "bytes[]" }],
    outputs: [],
  },
] as const;

function catalogEntries() {
  return deriveContractCatalog({
    chainId: 8453,
    address: POOL,
    abi: ABI as never,
  }).entries;
}

describe("selector catalog", () => {
  it("classifies a read by mutability, not by its name", () => {
    const entry = catalogEntries().find((e) => e.name === "maxDeposit");
    expect(entry?.riskClass).toBe("read");
  });

  it("reads the capability from the ABI name, so a raw write is not a loophole", () => {
    const byName = new Map(catalogEntries().map((e) => [e.name, e.capability]));
    expect(byName.get("supply")).toBe("protocol.lending.supply");
    expect(byName.get("borrow")).toBe("protocol.lending.borrow");
  });

  it("flags a dispatcher, because permitting it permits everything", () => {
    const entry = catalogEntries().find((e) => e.name === "multicall");
    expect(entry?.isDispatcher).toBe(true);
  });

  it("computes the known selector for a well-known signature", () => {
    const entry = catalogEntries().find((e) => e.name === "supply");
    expect(entry?.selector).toBe("0x617ba037");
  });
});

describe("managed scope", () => {
  const draft: StatementDraft = {
    sid: "r",
    effect: PolicyEffect.ALLOW,
    target: StatementTarget.ONCHAIN,
    chainId: 8453,
    address: POOL,
    selectors: [],
    entries: [],
  };

  it("claims the whole contract, never the empty-calldata sentinel", () => {
    const [scope] = draftManagedScopes([draft]);
    // The deep wildcard is only legal as a trailing segment of its own, so a
    // scope written as ".../fn/**" does not parse, and one that does not parse
    // is refused when the policy is saved.
    expect(parseArn(scope).ok, scope).toBe(true);
    expect(scope).not.toContain(`/fn/${ARN_SELECTOR_NONE}`);
    expect(arnStringMatches(scope, `${CONTRACT_ARN}/fn/0x617ba037`)).toBe(true);
  });

  it("covers a contract with an open function segment", () => {
    const [resource] = draftResources(draft);
    expect(resource).toContain("/fn/*");
    expect(resource).not.toContain(`/fn/${ARN_SELECTOR_NONE}`);
  });

  it("claims a control-plane target by kind, not by the one id allowed", () => {
    const [scope] = draftManagedScopes([
      {
        sid: "w",
        effect: PolicyEffect.DENY,
        target: StatementTarget.WALLET,
        controlCapabilities: ["wallet.role.update"],
        controlResourceId: "wallet_1",
        chainId: null,
        address: "",
        selectors: [],
        entries: [],
      },
    ]);
    expect(parseArn(scope).ok, scope).toBe(true);
    // Every wallet, not only the one the statement allows, or the others would
    // fall outside the policy entirely.
    expect(arnStringMatches(scope, "kh:wallet/wallet_1")).toBe(true);
    expect(arnStringMatches(scope, "kh:wallet/wallet_2")).toBe(true);
  });

  it("claims an offchain rule by capability, since it names no resource", () => {
    const draftOffchain: StatementDraft = {
      sid: "o",
      effect: PolicyEffect.DENY,
      target: StatementTarget.OFFCHAIN,
      controlCapabilities: ["offchain.http"],
      chainId: null,
      address: "",
      selectors: [],
      entries: [],
    };
    expect(draftManagedScopes([draftOffchain])).toEqual(["offchain.http"]);
    expect(draftResources(draftOffchain)).toEqual([]);
  });
});

describe("capabilities a rule emits", () => {
  const entries = catalogEntries().filter((e) => e.name === "supply");
  const emitted = draftCapabilities({
    sid: "r",
    effect: PolicyEffect.ALLOW,
    target: StatementTarget.ONCHAIN,
    chainId: 8453,
    address: POOL,
    selectors: [entries[0].selector],
    entries,
  });

  it("names what the selected functions do, not a coarse class", () => {
    expect(emitted).toContain("protocol.lending.supply");
  });

  it("names the plain verb too, so a lookup failure cannot unmatch the rule", () => {
    // The capability a request carries is read from the same catalog. Where
    // that cannot be reached it carries the plain verb, and a rule listing only
    // the semantic form would stop matching the function it names.
    expect(emitted).toContain("contract.write");
  });
});

describe("builder to text and back", () => {
  const cases: Record<string, PolicyStatement> = {
    "an onchain rule with a who, an asset and a limit": {
      sid: "bounded-supply",
      effect: PolicyEffect.ALLOW,
      capability: ["protocol.lending.supply"],
      resource: [`kh:chain/8453/contract/${POOL.toLowerCase()}/fn/0x617ba037`],
      condition: {
        usdValue: { lte: "25000" },
        counterparty: { in: ["0x1111111111111111111111111111111111111111"] },
        actorRole: { in: ["owner", "admin"] },
      },
      limit: [
        { metric: "usd", window: "1d", max: "100000", scope: "organization" },
      ],
    },
    "a control-plane rule scoped to a project": {
      sid: "sandbox-only",
      effect: PolicyEffect.ALLOW,
      capability: ["workflow.create"],
      resource: ["kh:workflow/*"],
      condition: { projectId: { in: ["proj_sandbox"] } },
    },
    "a rule naming one person": {
      sid: "ada-only",
      effect: PolicyEffect.DENY,
      capability: ["apikey.delete"],
      resource: ["kh:apikey/*"],
      condition: { actorId: { in: ["seed-user-ada"] } },
    },
  };

  for (const [name, statement] of Object.entries(cases)) {
    it(`keeps ${name}`, () => {
      const parsed = fromStatement(statement);
      expect(parsed).not.toBeNull();
      if (!parsed) {
        return;
      }

      // The builder holds no catalog entries for a statement it just loaded,
      // so the capability it re-emits comes from the stored statement.
      const rebuilt = toStatement({
        sid: parsed.sid,
        effect: parsed.effect,
        target: parsed.target,
        controlCapabilities: parsed.controlCapabilities,
        controlResourceId: parsed.controlResourceId,
        projectIds: parsed.projectIds,
        tagIds: parsed.tagIds,
        actorRoles: parsed.actorRoles,
        actorIds: parsed.actorIds,
        chainId: parsed.chainId,
        address: parsed.address,
        selectors: parsed.selectors,
        entries: [],
        assets: parsed.assets,
        counterparties: parsed.counterparties,
        condition: parsed.maxUsd
          ? { usdValue: { lte: parsed.maxUsd } }
          : undefined,
        limit: parsed.dailyUsd
          ? [
              {
                metric: "usd",
                window: "1d",
                max: parsed.dailyUsd,
                scope: "organization",
              },
            ]
          : [],
      });

      expect(rebuilt.condition).toEqual(statement.condition);
      expect(rebuilt.limit ?? []).toEqual(statement.limit ?? []);
      expect(rebuilt.resource).toEqual(statement.resource);
      expect(rebuilt.effect).toBe(statement.effect);
    });
  }

  it("survives a whole document going through JSON, as the text view does", () => {
    const document: PolicyDocument = {
      schemaVersion: POLICY_SCHEMA_VERSION,
      name: "Draft policy",
      enforcement: "monitor",
      manages: [`kh:chain/8453/contract/${POOL.toLowerCase()}/fn/**`],
      statements: [cases["an onchain rule with a who, an asset and a limit"]],
    };
    const viaText = JSON.parse(JSON.stringify(document)) as PolicyDocument;
    expect(viaText).toEqual(document);
    expect(fromStatement(viaText.statements[0])).not.toBeNull();
  });
});

describe("what the builder refuses to draw", () => {
  it("names the exact condition it cannot edit, rather than failing vaguely", () => {
    const reason = unrepresentable({
      sid: "exotic",
      effect: PolicyEffect.DENY,
      capability: ["asset.approve"],
      resource: [`kh:chain/8453/contract/${POOL.toLowerCase()}/fn/*`],
      condition: { unbounded: { eq: true }, triggerType: { eq: "webhook" } },
    });
    expect(reason?.reason).toContain("unbounded");
    expect(reason?.reason).toContain("triggerType");
  });

  it("refuses to parse what it cannot draw, so nothing is silently dropped", () => {
    expect(
      fromStatement({
        sid: "exotic",
        effect: PolicyEffect.DENY,
        capability: ["asset.approve"],
        resource: [`kh:chain/8453/contract/${POOL.toLowerCase()}/fn/*`],
        condition: { unbounded: { eq: true } },
      })
    ).toBeNull();
  });

  it("accepts an offchain rule that names no resource", () => {
    expect(
      unrepresentable({
        sid: "no-http",
        effect: PolicyEffect.DENY,
        capability: ["offchain.http"],
      })
    ).toBeNull();
  });
});
