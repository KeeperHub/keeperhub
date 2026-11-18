import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getOrgRole: vi.fn(),
  organizationHasWallet: vi.fn(),
  provisionOrganizationWallet: vi.fn(),
  recordAuditEvent: vi.fn(),
  recordWalletInAddressBook: vi.fn(),
  logSystemError: vi.fn(),
}));

// lib/auth pulls in lib/redis (via login-risk) which imports ioredis.
vi.mock("ioredis", () => ({ Redis: class {} }));

vi.mock("@/lib/security/org-role", () => ({
  getOrgRole: mocks.getOrgRole,
}));

vi.mock("@/lib/web3/wallet-helpers", () => ({
  organizationHasWallet: mocks.organizationHasWallet,
}));

vi.mock("@/lib/turnkey/provision-org-wallet", () => ({
  provisionOrganizationWallet: mocks.provisionOrganizationWallet,
}));

vi.mock("@/lib/security/audit-log", () => ({
  recordAuditEvent: mocks.recordAuditEvent,
}));

vi.mock("@/lib/address-book/record-wallet", () => ({
  recordWalletInAddressBook: mocks.recordWalletInAddressBook,
}));

vi.mock("@/lib/logging", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/logging")>();
  return { ...actual, logSystemError: mocks.logSystemError };
});

import { auth } from "@/lib/auth";
import { db } from "@/lib/db";

const USER_ID = "user-1";
const ORG_ID = "org-1";
const EMAIL = "member@example.com";

type SessionCreateAfter = (
  session: Record<string, unknown>,
  context: null
) => Promise<void>;

function sessionCreateAfter(): SessionCreateAfter {
  const hook = auth.options.databaseHooks?.session?.create?.after;
  if (!hook) {
    throw new Error("session.create.after hook is not registered");
  }
  return hook as unknown as SessionCreateAfter;
}

type UserRowChain = {
  from: () => UserRowChain;
  where: () => UserRowChain;
  limit: () => Promise<Array<{ email: string; name: string }>>;
};

function stubUserRow(): void {
  const chain: UserRowChain = {
    from: () => chain,
    where: () => chain,
    limit: () => Promise.resolve([{ email: EMAIL, name: "Member" }]),
  };
  vi.spyOn(db, "select").mockReturnValue(
    chain as unknown as ReturnType<typeof db.select>
  );
}

async function runSessionCreate(): Promise<void> {
  await sessionCreateAfter()(
    {
      id: "session-1",
      userId: USER_ID,
      activeOrganizationId: ORG_ID,
      ipAddress: null,
      userAgent: null,
    },
    null
  );
}

function flushBackgroundWork(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

describe("session create wallet backstop", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    mocks.organizationHasWallet.mockResolvedValue(false);
    mocks.provisionOrganizationWallet.mockResolvedValue({ created: true });
    mocks.recordAuditEvent.mockResolvedValue(undefined);
    stubUserRow();
  });

  it("does not provision a wallet when the member is a viewer", async () => {
    mocks.getOrgRole.mockResolvedValue("viewer");

    await runSessionCreate();
    await vi.waitFor(() => {
      expect(mocks.getOrgRole).toHaveBeenCalledWith(USER_ID, ORG_ID);
    });
    await flushBackgroundWork();

    expect(mocks.provisionOrganizationWallet).not.toHaveBeenCalled();
    expect(mocks.logSystemError).not.toHaveBeenCalled();
  });

  it("provisions a wallet for a member when the org has none", async () => {
    mocks.getOrgRole.mockResolvedValue("member");

    await runSessionCreate();
    await vi.waitFor(() => {
      expect(mocks.provisionOrganizationWallet).toHaveBeenCalledWith({
        userId: USER_ID,
        organizationId: ORG_ID,
        email: EMAIL,
      });
    });
    expect(mocks.logSystemError).not.toHaveBeenCalled();
  });
});
