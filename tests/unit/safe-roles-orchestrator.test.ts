import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// The orchestrator's module-load surface is wide; only the things that
// touch external state at module load (DB / drizzle helpers) need mocks.
// Pure helpers (address-utils, ethers, allowance-module) are left real
// so the assertions exercise the actual transformation pipeline.

const selectLimitMock = vi.fn();

vi.mock("@/lib/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: selectLimitMock,
        }),
      }),
    }),
  },
}));

// Schema names accessed via destructured imports -- mocked as opaque
// sentinel objects so the orchestrator's top-level import doesn't crash.
vi.mock("@/lib/db/schema", () => ({
  organizationWallets: {},
  safeRoleAllowances: {},
  safeRoleDirectRules: {},
  safeRoleProtocols: {},
  safeRoles: {
    safeWalletId: "safeWalletId",
    roleType: "roleType",
  },
  safeWallets: {},
}));

vi.mock("drizzle-orm", () => ({
  and: () => ({}),
  eq: () => ({}),
  inArray: () => ({}),
  sql: () => ({}),
}));

import {
  DIRECT_RULE_PROTOCOL_SLUG,
  type DirectRuleInput,
  flattenInstallInput,
  getSafeRole,
  NATIVE_TOKEN_SENTINEL,
  type ProtocolInput,
} from "@/lib/safe/roles-orchestrator";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const TOKEN_USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const TOKEN_DAI = "0x6B175474E89094C44Da98b954EedeAC495271d0F";
const RECIPIENT = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const DAY_SECONDS = 86_400;

function usdcProtocol(amountHuman = "100"): ProtocolInput {
  return {
    slug: "aave-v3",
    tokens: [
      {
        tokenAddress: TOKEN_USDC,
        tokenSymbol: "USDC",
        tokenDecimals: 6,
        amountHuman,
        periodSeconds: DAY_SECONDS,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// flattenInstallInput
// ---------------------------------------------------------------------------

describe("flattenInstallInput", () => {
  it("returns empty arrays on empty input", () => {
    const result = flattenInstallInput([]);
    expect(result).toEqual({
      protocolSlugs: [],
      allowedTokenSymbols: [],
      allowances: [],
    });
  });

  it("emits one allowance row per (protocol, token) and surfaces the slug and symbol", () => {
    const result = flattenInstallInput([usdcProtocol("100")]);

    expect(result.protocolSlugs).toEqual(["aave-v3"]);
    expect(result.allowedTokenSymbols).toEqual(["USDC"]);
    expect(result.allowances).toHaveLength(1);
    expect(result.allowances[0]).toMatchObject({
      protocolSlug: "aave-v3",
      tokenSymbol: "USDC",
      tokenDecimals: 6,
      maxRefillWei: "100000000",
      refillWei: "100000000",
      periodSeconds: DAY_SECONDS,
    });
    expect(result.allowances[0].directRule).toBeUndefined();
  });

  it("keeps two protocols on the same token as independent allowance buckets", () => {
    const result = flattenInstallInput([
      usdcProtocol("100"),
      {
        slug: "compound-v3",
        tokens: [
          {
            tokenAddress: TOKEN_USDC,
            tokenSymbol: "USDC",
            tokenDecimals: 6,
            amountHuman: "50",
            periodSeconds: DAY_SECONDS,
          },
        ],
      },
    ]);

    expect(result.protocolSlugs).toEqual(["aave-v3", "compound-v3"]);
    expect(result.allowances).toHaveLength(2);
    const slugsByCap = result.allowances.reduce<Record<string, string>>(
      (acc, a) => {
        acc[a.protocolSlug] = a.maxRefillWei;
        return acc;
      },
      {}
    );
    expect(slugsByCap["aave-v3"]).toBe("100000000");
    expect(slugsByCap["compound-v3"]).toBe("50000000");
  });

  it("emits an allowance with directRule populated for an ERC-20 direct rule", () => {
    const rule: DirectRuleInput = {
      kind: "erc20-transfer",
      tokenAddress: TOKEN_DAI,
      tokenSymbol: "DAI",
      tokenDecimals: 18,
      counterparty: RECIPIENT,
      amountHuman: "10",
      periodSeconds: 604_800,
    };

    const result = flattenInstallInput([], [rule]);

    expect(result.protocolSlugs).toEqual([]);
    expect(result.allowedTokenSymbols).toEqual(["DAI"]);
    expect(result.allowances).toHaveLength(1);
    const [allowance] = result.allowances;
    expect(allowance.protocolSlug).toBe(DIRECT_RULE_PROTOCOL_SLUG);
    expect(allowance.directRule).toEqual({
      kind: "erc20-transfer",
      counterparty: RECIPIENT,
    });
    expect(allowance.maxRefillWei).toBe(
      (BigInt(10) * BigInt(10) ** BigInt(18)).toString()
    );
  });

  it("stores native-transfer rules under the NATIVE_TOKEN_SENTINEL token address", () => {
    const rule: DirectRuleInput = {
      kind: "native-transfer",
      tokenAddress: null,
      tokenSymbol: "ETH",
      tokenDecimals: 18,
      counterparty: RECIPIENT,
      amountHuman: "1",
      periodSeconds: DAY_SECONDS,
    };

    const result = flattenInstallInput([], [rule]);

    expect(result.allowances).toHaveLength(1);
    expect(result.allowances[0].tokenAddress).toBe(NATIVE_TOKEN_SENTINEL);
    expect(result.allowances[0].directRule).toEqual({
      kind: "native-transfer",
      counterparty: RECIPIENT,
    });
  });

  it("silently skips ERC-20 direct rules whose tokenAddress is null", () => {
    const rule: DirectRuleInput = {
      kind: "erc20-approve",
      tokenAddress: null,
      tokenSymbol: "???",
      tokenDecimals: 18,
      counterparty: RECIPIENT,
      amountHuman: "1",
      periodSeconds: DAY_SECONDS,
    };

    const result = flattenInstallInput([], [rule]);

    expect(result.allowances).toHaveLength(0);
    expect(result.allowedTokenSymbols).toEqual([]);
  });

  it("normalizes token addresses to lowercase storage form", () => {
    const result = flattenInstallInput([usdcProtocol("1")]);

    expect(result.allowances[0].tokenAddress).toBe(TOKEN_USDC.toLowerCase());
  });

  it("converts sub-decimal humanToWei amounts precisely", () => {
    // 0.000001 USDC at 6 decimals == 1 wei-equivalent.
    const result = flattenInstallInput([
      {
        slug: "any",
        tokens: [
          {
            tokenAddress: TOKEN_USDC,
            tokenSymbol: "USDC",
            tokenDecimals: 6,
            amountHuman: "0.000001",
            periodSeconds: DAY_SECONDS,
          },
        ],
      },
    ]);

    expect(result.allowances[0].maxRefillWei).toBe("1");
  });

  it("deduplicates the same token symbol across protocols and direct rules", () => {
    const result = flattenInstallInput(
      [usdcProtocol("1")],
      [
        {
          kind: "erc20-transfer",
          tokenAddress: TOKEN_USDC,
          tokenSymbol: "USDC",
          tokenDecimals: 6,
          counterparty: RECIPIENT,
          amountHuman: "1",
          periodSeconds: DAY_SECONDS,
        },
      ]
    );

    // Same symbol present in both protocol and direct rule -- the union
    // set in allowedTokenSymbols should hold it only once even though
    // the allowance list holds both buckets.
    expect(result.allowedTokenSymbols).toEqual(["USDC"]);
    expect(result.allowances).toHaveLength(2);
    expect(result.allowances.map((a) => a.protocolSlug).sort()).toEqual(
      ["aave-v3", DIRECT_RULE_PROTOCOL_SLUG].sort()
    );
  });
});

// ---------------------------------------------------------------------------
// getSafeRole
// ---------------------------------------------------------------------------

describe("getSafeRole", () => {
  beforeEach(() => {
    selectLimitMock.mockReset();
  });

  it("returns the role row when one matches the safe id", async () => {
    const roleRow = {
      id: "role-1",
      safeWalletId: "safe-1",
      roleType: "automation",
      status: "active",
    };
    selectLimitMock.mockResolvedValueOnce([roleRow]);

    const result = await getSafeRole("safe-1");

    expect(result).toBe(roleRow);
    expect(selectLimitMock).toHaveBeenCalledOnce();
  });

  it("returns null when no matching role row exists", async () => {
    selectLimitMock.mockResolvedValueOnce([]);

    expect(await getSafeRole("safe-with-no-role")).toBeNull();
  });

  it("returns a revoked role unchanged - status filtering is the caller's responsibility", async () => {
    // The orchestrator deliberately surfaces revoked roles so the
    // workflow runner and the UI can show "this Safe used to have a
    // role" rather than silently treating the Safe as ungoverned.
    const revokedRow = {
      id: "role-2",
      safeWalletId: "safe-2",
      roleType: "automation",
      status: "revoked",
    };
    selectLimitMock.mockResolvedValueOnce([revokedRow]);

    expect(await getSafeRole("safe-2")).toBe(revokedRow);
  });
});
