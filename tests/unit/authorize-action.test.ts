import { beforeEach, describe, expect, it, vi } from "vitest";

// Drizzle chain stub: distinguish the two queries by their selected columns
// ("role" -> member role, "twoFactorEnabled" -> users 2FA). Configure rows per test.
const state: {
  role: string | undefined;
  twoFactorEnabled: boolean | undefined;
} = { role: undefined, twoFactorEnabled: undefined };

function rowsFor(cols: Record<string, unknown>): unknown[] {
  if ("role" in cols) {
    return state.role === undefined ? [] : [{ role: state.role }];
  }
  return state.twoFactorEnabled === undefined
    ? []
    : [{ twoFactorEnabled: state.twoFactorEnabled }];
}

vi.mock("@/lib/db", () => ({
  db: {
    select: (cols: Record<string, unknown>) => {
      const chain = {
        from: () => chain,
        where: () => chain,
        limit: () => Promise.resolve(rowsFor(cols)),
      };
      return chain;
    },
  },
}));

const { mockCompliance, mockRequireStepUp } = vi.hoisted(() => ({
  mockCompliance: vi.fn(),
  mockRequireStepUp: vi.fn(),
}));

vi.mock("@/lib/mfa/org-mfa-enforcement", () => ({
  checkWalletOrgMfaCompliance: mockCompliance,
}));

vi.mock("@/lib/mfa/wallet-step-up", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/mfa/wallet-step-up")
  >("@/lib/mfa/wallet-step-up");
  return { ...actual, requireStepUp: mockRequireStepUp };
});

import { authorizeAction } from "@/lib/middleware/authorize-action";

function makeSession(opts: {
  email: string;
  name?: string;
  isAnonymous?: boolean;
  requiresMfa?: boolean;
  activeOrganizationId?: string | null;
}) {
  return {
    user: {
      id: "user_1",
      email: opts.email,
      name: opts.name ?? "Jane",
      isAnonymous: opts.isAnonymous ?? false,
    },
    session: {
      requiresMfa: opts.requiresMfa ?? false,
      activeOrganizationId: opts.activeOrganizationId ?? "org_1",
    },
  };
}

const WALLET = "0xabc@wallet.keeperhub.com";
const EMAIL = "jane@example.com";

async function codeOf(response: Response): Promise<string | undefined> {
  return ((await response.json()) as { code?: string }).code;
}

beforeEach(() => {
  state.role = undefined;
  state.twoFactorEnabled = undefined;
  mockCompliance.mockReset();
  mockCompliance.mockResolvedValue({ compliant: true, required: [] });
  mockRequireStepUp.mockReset();
  mockRequireStepUp.mockResolvedValue({ ok: true });
});

const base = {
  action: "wallet_withdraw",
  body: {},
  headers: new Headers(),
};

describe("authorizeAction decision matrix", () => {
  it("rejects anonymous accounts before anything else", async () => {
    const res = await authorizeAction({
      ...base,
      session: makeSession({ email: EMAIL, name: "Anonymous" }),
      roleFloor: "owner",
      organizationId: "org_1",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.response.status).toBe(403);
      expect(await codeOf(res.response)).toBe("anonymous_forbidden");
    }
  });

  it("enforces the owner floor for non-wallet users", async () => {
    state.role = "member";
    const res = await authorizeAction({
      ...base,
      session: makeSession({ email: EMAIL }),
      roleFloor: "owner",
      organizationId: "org_1",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(await codeOf(res.response)).toBe("not_owner");
    }
  });

  it("enforces the admin floor", async () => {
    state.role = "member";
    const res = await authorizeAction({
      ...base,
      session: makeSession({ email: EMAIL }),
      roleFloor: "admin",
      organizationId: "org_1",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(await codeOf(res.response)).toBe("not_admin_or_owner");
    }
  });

  it("blocks a non-wallet user whose session is step-up pending", async () => {
    state.role = "owner";
    const res = await authorizeAction({
      ...base,
      session: makeSession({ email: EMAIL, requiresMfa: true }),
      roleFloor: "owner",
      organizationId: "org_1",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(await codeOf(res.response)).toBe("mfa_pending");
    }
  });

  it("blocks a non-wallet user who has not enrolled 2FA", async () => {
    state.role = "owner";
    state.twoFactorEnabled = false;
    const res = await authorizeAction({
      ...base,
      session: makeSession({ email: EMAIL }),
      roleFloor: "owner",
      organizationId: "org_1",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(await codeOf(res.response)).toBe("mfa_not_enrolled");
    }
  });

  it("passes a non-wallet owner with 2FA to the step-up challenge", async () => {
    state.role = "owner";
    state.twoFactorEnabled = true;
    const res = await authorizeAction({
      ...base,
      session: makeSession({ email: EMAIL }),
      roleFloor: "owner",
      organizationId: "org_1",
    });
    expect(res.ok).toBe(true);
    expect(mockRequireStepUp).toHaveBeenCalledTimes(1);
  });

  it("surfaces the step-up challenge response unchanged", async () => {
    state.role = "owner";
    state.twoFactorEnabled = true;
    mockRequireStepUp.mockResolvedValue({
      ok: false,
      status: 401,
      error: "Confirm this action to continue.",
      code: "factors_required",
    });
    const res = await authorizeAction({
      ...base,
      session: makeSession({ email: EMAIL }),
      roleFloor: "owner",
      organizationId: "org_1",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.response.status).toBe(401);
      expect(await codeOf(res.response)).toBe("factors_required");
    }
  });

  it("lets a wallet owner through WITHOUT 2FA enrollment (signature only)", async () => {
    state.role = "owner";
    // twoFactorEnabled left undefined: the query must never be consulted.
    const res = await authorizeAction({
      ...base,
      session: makeSession({ email: WALLET }),
      roleFloor: "owner",
      organizationId: "org_1",
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.accountKind).toBe("wallet");
    }
    expect(mockRequireStepUp).toHaveBeenCalledTimes(1);
  });

  it("still enforces the role floor for wallet users", async () => {
    state.role = "member";
    const res = await authorizeAction({
      ...base,
      session: makeSession({ email: WALLET }),
      roleFloor: "owner",
      organizationId: "org_1",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(await codeOf(res.response)).toBe("not_owner");
    }
  });

  it("blocks a wallet user who is non-compliant with org enforcement", async () => {
    state.role = "owner";
    mockCompliance.mockResolvedValue({ compliant: false, required: ["totp"] });
    const res = await authorizeAction({
      ...base,
      session: makeSession({ email: WALLET }),
      roleFloor: "owner",
      organizationId: "org_1",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(await codeOf(res.response)).toBe("org_mfa_enrollment_required");
    }
  });

  it("allows a wallet user-scoped action with no role floor", async () => {
    const res = await authorizeAction({
      ...base,
      action: "user_api_key_manage",
      session: makeSession({ email: WALLET }),
      roleFloor: "none",
    });
    expect(res.ok).toBe(true);
    expect(mockRequireStepUp).toHaveBeenCalledTimes(1);
  });
});
