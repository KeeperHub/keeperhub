import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getSafeAppUrl,
  getSafeChainPrefix,
} from "@/components/safe/chain-prefixes";

vi.mock("server-only", () => ({}));

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

vi.mock("@/lib/db/schema", () => ({
  safeWallets: {
    id: "id",
    safeAddress: "safeAddress",
    status: "status",
    isSigningActive: "isSigningActive",
    organizationId: "organizationId",
    chainId: "chainId",
  },
  safeRoles: {
    rolesModifierAddress: "rolesModifierAddress",
    roleKey: "roleKey",
    delegateAddress: "delegateAddress",
    status: "status",
    safeWalletId: "safeWalletId",
    roleType: "roleType",
  },
}));

vi.mock("drizzle-orm", () => ({
  and: () => ({}),
  eq: () => ({}),
}));

const getOrganizationWalletAddressMock = vi.fn();
const getOrganizationWalletMock = vi.fn();

vi.mock("@/lib/web3/wallet-helpers", () => ({
  getOrganizationWallet: getOrganizationWalletMock,
  getOrganizationWalletAddress: getOrganizationWalletAddressMock,
}));

vi.mock("@/lib/address-utils", () => ({
  normalizeAddressForStorage: (addr: string) => addr.toLowerCase(),
}));

// The signer-resolver pulls these in for the chain-state probe + reconcile
// fallback. Tests want to stay DB-only so we stub them to "no modules on
// chain" and a no-op reconcile -- the routing behaviour we're asserting
// here is purely the DB-based decision.
const rpcEvmMock = vi.fn();
vi.mock("@/lib/rpc/engine", async () => ({
  ...(await vi.importActual("@/lib/rpc/engine/types")),
  ...(await vi.importActual("@/lib/rpc/engine/scope")),
  ...(await vi.importActual("@/lib/rpc/engine/route-error")),
  rpc: { evm: rpcEvmMock },
}));
vi.mock("@/lib/safe/zodiac-roles", () => ({
  readEnabledSafeModules: async () => [],
  findRolesModifierForSafe: async () => null,
}));
vi.mock("@/lib/safe/zodiac-contracts", () => ({
  orgAutomationRoleKey: () => "0xrole",
}));
vi.mock("@/lib/safe/roles-orchestrator", () => ({
  reconcileSafeRoleFromChain: async () => ({
    success: true,
    installed: false,
    reason: "no-roles-modifier",
  }),
}));
const logSystemErrorMock = vi.fn();
const logUserErrorMock = vi.fn();
vi.mock("@/lib/logging", () => ({
  ErrorCategory: { TRANSACTION: "transaction" },
  logSystemError: logSystemErrorMock,
  logUserError: logUserErrorMock,
}));

// Import after mocks
const { resolveSignerMode, resolveSignerForNode, parseWeb3Connection } =
  await import("@/lib/safe/signer-resolver");

const { RpcRouteError, RpcRouteErrorCode } = await import(
  "@/lib/rpc/engine/route-error"
);
const { orgScope } = await import("@/lib/rpc/engine/scope");
const { RpcSelectionMode } = await import("@/lib/rpc/engine/types");

const PROBE_CLIENT = {
  manager: {
    executeWithFailover: (op: (provider: unknown) => unknown) => op({}),
  },
};

const ORG_ID = "org_test";
const CHAIN_ID = 8453;
const OWNER = "0xAAAA000000000000000000000000000000000000";
const SAFE = "0xBBBB000000000000000000000000000000000000";

beforeEach(() => {
  rpcEvmMock.mockReset();
  rpcEvmMock.mockResolvedValue(PROBE_CLIENT);
  logSystemErrorMock.mockReset();
  logUserErrorMock.mockReset();
});

describe("resolveSignerMode", () => {
  beforeEach(() => {
    selectLimitMock.mockReset();
    getOrganizationWalletAddressMock.mockReset();
    getOrganizationWalletAddressMock.mockResolvedValue(OWNER);
  });

  it("returns eoa mode when no Safe exists for (org, chain)", async () => {
    selectLimitMock.mockResolvedValue([]);
    const mode = await resolveSignerMode(ORG_ID, CHAIN_ID);
    expect(mode.kind).toBe("eoa");
    if (mode.kind === "eoa") {
      expect(mode.ownerAddress).toBe(OWNER.toLowerCase());
    }
  });

  it("returns eoa mode when Safe exists but signing toggle is off", async () => {
    selectLimitMock.mockResolvedValue([
      {
        id: "safe-1",
        safeAddress: SAFE,
        status: "deployed",
        isSigningActive: false,
      },
    ]);
    const mode = await resolveSignerMode(ORG_ID, CHAIN_ID);
    expect(mode.kind).toBe("eoa");
  });

  it("returns eoa mode when Safe is still pending even if toggle is on", async () => {
    selectLimitMock.mockResolvedValue([
      {
        id: "safe-1",
        safeAddress: SAFE,
        status: "pending",
        isSigningActive: true,
      },
    ]);
    const mode = await resolveSignerMode(ORG_ID, CHAIN_ID);
    expect(mode.kind).toBe("eoa");
  });

  it("returns safe mode when Safe is deployed and toggle is on", async () => {
    // First .limit() call (safeWallets) -> the deployed Safe.
    // Second .limit() call (safeRoles) -> empty: no DB role row.
    // Chain probe is mocked to return no modules, so signer-resolver
    // falls through to plain `safe` mode.
    selectLimitMock
      .mockResolvedValueOnce([
        {
          id: "safe-1",
          safeAddress: SAFE,
          status: "deployed",
          isSigningActive: true,
        },
      ])
      .mockResolvedValueOnce([]);
    const mode = await resolveSignerMode(ORG_ID, CHAIN_ID);
    expect(mode.kind).toBe("safe");
    if (mode.kind === "safe") {
      expect(mode.ownerAddress).toBe(OWNER.toLowerCase());
      expect(mode.safeAddress).toBe(SAFE);
      expect(mode.safeWalletId).toBe("safe-1");
    }
  });

  it("probes for a modifier on KeeperHub's endpoints for the organization", async () => {
    selectLimitMock
      .mockResolvedValueOnce([
        {
          id: "safe-1",
          safeAddress: SAFE,
          status: "deployed",
          isSigningActive: true,
        },
      ])
      .mockResolvedValueOnce([]);

    await resolveSignerMode(ORG_ID, CHAIN_ID);

    expect(rpcEvmMock).toHaveBeenCalledTimes(1);
    expect(rpcEvmMock).toHaveBeenCalledWith(
      orgScope(ORG_ID, { mode: RpcSelectionMode.PLATFORM }),
      CHAIN_ID
    );
  });

  it("falls back to the organization's own route when it allows only its own RPC", async () => {
    selectLimitMock
      .mockResolvedValueOnce([
        {
          id: "safe-1",
          safeAddress: SAFE,
          status: "deployed",
          isSigningActive: true,
        },
      ])
      .mockResolvedValueOnce([]);
    rpcEvmMock.mockRejectedValueOnce(
      new RpcRouteError(RpcRouteErrorCode.PLATFORM_FORBIDDEN, CHAIN_ID)
    );

    const mode = await resolveSignerMode(ORG_ID, CHAIN_ID);

    expect(mode.kind).toBe("safe");
    expect(rpcEvmMock).toHaveBeenLastCalledWith(orgScope(ORG_ID), CHAIN_ID);
    expect(logSystemErrorMock).not.toHaveBeenCalled();
    expect(logUserErrorMock).not.toHaveBeenCalled();
  });

  it("logs a route the organization cannot use as a user error, not a system one", async () => {
    selectLimitMock
      .mockResolvedValueOnce([
        {
          id: "safe-1",
          safeAddress: SAFE,
          status: "deployed",
          isSigningActive: true,
        },
      ])
      .mockResolvedValueOnce([]);
    rpcEvmMock
      .mockRejectedValueOnce(
        new RpcRouteError(RpcRouteErrorCode.PLATFORM_FORBIDDEN, CHAIN_ID)
      )
      .mockRejectedValueOnce(
        new RpcRouteError(RpcRouteErrorCode.NOT_COVERED, CHAIN_ID)
      );

    const mode = await resolveSignerMode(ORG_ID, CHAIN_ID);

    expect(mode.kind).toBe("safe");
    expect(logUserErrorMock).toHaveBeenCalledTimes(1);
    expect(logSystemErrorMock).not.toHaveBeenCalled();
  });

  it("returns safe-role mode when DB has the role row", async () => {
    selectLimitMock
      .mockResolvedValueOnce([
        {
          id: "safe-1",
          safeAddress: SAFE,
          status: "deployed",
          isSigningActive: true,
        },
      ])
      .mockResolvedValueOnce([
        {
          rolesModifierAddress: "0xMOD",
          roleKey: "0xkey",
          delegateAddress: "0xdelegate",
          status: "active",
        },
      ]);
    const mode = await resolveSignerMode(ORG_ID, CHAIN_ID);
    expect(mode.kind).toBe("safe-role");
    if (mode.kind === "safe-role") {
      expect(mode.rolesModifierAddress).toBe("0xMOD");
      expect(mode.roleKey).toBe("0xkey");
    }
  });
});

const SAFE_ID_EMPTY_RE = /safe id is empty/;
const INVALID_WEB3_RE = /Invalid web3Connection/;
const UNKNOWN_SAFE_RE = /unknown Safe/;
const WRONG_ORG_RE = /does not belong to this organization/;
const WRONG_CHAIN_RE = /is on chain 1/;
const NOT_DEPLOYED_RE = /not deployed yet/;

describe("parseWeb3Connection", () => {
  it("treats undefined and empty as default (org-policy)", () => {
    expect(parseWeb3Connection(undefined)).toEqual({ kind: "default" });
    expect(parseWeb3Connection(null)).toEqual({ kind: "default" });
    expect(parseWeb3Connection("")).toEqual({ kind: "default" });
    expect(parseWeb3Connection("default")).toEqual({ kind: "default" });
  });

  it("parses eoa override", () => {
    expect(parseWeb3Connection("eoa")).toEqual({ kind: "eoa" });
  });

  it("parses safe pin and pulls out the id", () => {
    expect(parseWeb3Connection("safe:abc123")).toEqual({
      kind: "safe",
      safeWalletId: "abc123",
    });
  });

  it("throws on empty safe id", () => {
    expect(() => parseWeb3Connection("safe:")).toThrowError(SAFE_ID_EMPTY_RE);
  });

  it("throws on unrecognised prefix", () => {
    expect(() => parseWeb3Connection("garbage")).toThrowError(INVALID_WEB3_RE);
  });
});

describe("resolveSignerForNode", () => {
  beforeEach(() => {
    selectLimitMock.mockReset();
    getOrganizationWalletAddressMock.mockReset();
    getOrganizationWalletAddressMock.mockResolvedValue(OWNER);
  });

  it("default + no Safe -> eoa (delegates to resolveSignerMode)", async () => {
    selectLimitMock.mockResolvedValue([]);
    const mode = await resolveSignerForNode({
      organizationId: ORG_ID,
      chainId: CHAIN_ID,
      web3Connection: "default",
    });
    expect(mode.kind).toBe("eoa");
  });

  it("explicit eoa short-circuits even when org Safe is active", async () => {
    // selectLimitMock is NOT primed: the eoa branch must not touch the DB.
    const mode = await resolveSignerForNode({
      organizationId: ORG_ID,
      chainId: CHAIN_ID,
      web3Connection: "eoa",
    });
    expect(mode.kind).toBe("eoa");
    if (mode.kind === "eoa") {
      expect(mode.ownerAddress).toBe(OWNER.toLowerCase());
    }
    expect(selectLimitMock).not.toHaveBeenCalled();
  });

  it("safe:<id> resolves to plain safe mode when no role is active", async () => {
    selectLimitMock
      .mockResolvedValueOnce([
        {
          id: "safe-1",
          organizationId: ORG_ID,
          chainId: CHAIN_ID,
          safeAddress: SAFE,
          status: "deployed",
          isSigningActive: true,
        },
      ])
      .mockResolvedValueOnce([]);
    const mode = await resolveSignerForNode({
      organizationId: ORG_ID,
      chainId: CHAIN_ID,
      web3Connection: "safe:safe-1",
    });
    expect(mode.kind).toBe("safe");
    if (mode.kind === "safe") {
      expect(mode.safeWalletId).toBe("safe-1");
      expect(mode.safeAddress).toBe(SAFE);
    }
  });

  it("safe:<id> auto-upgrades to safe-role when DB has an active role", async () => {
    selectLimitMock
      .mockResolvedValueOnce([
        {
          id: "safe-1",
          organizationId: ORG_ID,
          chainId: CHAIN_ID,
          safeAddress: SAFE,
          status: "deployed",
          isSigningActive: true,
        },
      ])
      .mockResolvedValueOnce([
        {
          rolesModifierAddress: "0xMOD",
          roleKey: "0xkey",
          delegateAddress: "0xdelegate",
          status: "active",
        },
      ]);
    const mode = await resolveSignerForNode({
      organizationId: ORG_ID,
      chainId: CHAIN_ID,
      web3Connection: "safe:safe-1",
    });
    expect(mode.kind).toBe("safe-role");
    if (mode.kind === "safe-role") {
      expect(mode.rolesModifierAddress).toBe("0xMOD");
    }
  });

  it("rejects safe:<id> when the Safe row is missing", async () => {
    selectLimitMock.mockResolvedValueOnce([]);
    await expect(
      resolveSignerForNode({
        organizationId: ORG_ID,
        chainId: CHAIN_ID,
        web3Connection: "safe:does-not-exist",
      })
    ).rejects.toThrow(UNKNOWN_SAFE_RE);
  });

  it("rejects safe:<id> when the Safe belongs to a different org", async () => {
    selectLimitMock.mockResolvedValueOnce([
      {
        id: "safe-1",
        organizationId: "org_other",
        chainId: CHAIN_ID,
        safeAddress: SAFE,
        status: "deployed",
        isSigningActive: true,
      },
    ]);
    await expect(
      resolveSignerForNode({
        organizationId: ORG_ID,
        chainId: CHAIN_ID,
        web3Connection: "safe:safe-1",
      })
    ).rejects.toThrow(WRONG_ORG_RE);
  });

  it("rejects safe:<id> when the Safe is on a different chain", async () => {
    selectLimitMock.mockResolvedValueOnce([
      {
        id: "safe-1",
        organizationId: ORG_ID,
        chainId: 1,
        safeAddress: SAFE,
        status: "deployed",
        isSigningActive: true,
      },
    ]);
    await expect(
      resolveSignerForNode({
        organizationId: ORG_ID,
        chainId: CHAIN_ID,
        web3Connection: "safe:safe-1",
      })
    ).rejects.toThrow(WRONG_CHAIN_RE);
  });

  it("rejects safe:<id> when the Safe is not yet deployed", async () => {
    selectLimitMock.mockResolvedValueOnce([
      {
        id: "safe-1",
        organizationId: ORG_ID,
        chainId: CHAIN_ID,
        safeAddress: SAFE,
        status: "pending",
        isSigningActive: false,
      },
    ]);
    await expect(
      resolveSignerForNode({
        organizationId: ORG_ID,
        chainId: CHAIN_ID,
        web3Connection: "safe:safe-1",
      })
    ).rejects.toThrow(NOT_DEPLOYED_RE);
  });
});

describe("chain-prefixes", () => {
  it("returns app.safe.global URL for supported mainnets", () => {
    expect(getSafeAppUrl(1, SAFE)).toBe(
      `https://app.safe.global/home?safe=eth:${SAFE}`
    );
    expect(getSafeAppUrl(8453, SAFE)).toBe(
      `https://app.safe.global/home?safe=base:${SAFE}`
    );
  });

  it("returns app.safe.global URL for supported testnets", () => {
    expect(getSafeAppUrl(11_155_111, SAFE)).toBe(
      `https://app.safe.global/home?safe=sep:${SAFE}`
    );
    expect(getSafeAppUrl(84_532, SAFE)).toBe(
      `https://app.safe.global/home?safe=basesep:${SAFE}`
    );
  });

  it("returns null for unknown chains (UI should hide the link)", () => {
    expect(getSafeChainPrefix(9999)).toBeNull();
    expect(getSafeAppUrl(9999, SAFE)).toBeNull();
  });
});
