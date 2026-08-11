import { beforeEach, describe, expect, it, vi } from "vitest";

// Chainable drizzle-query stubs. resolveOwnerEmails ends on `.where()`;
// resolveActorLabel ends on `.limit()`. The terminal method returns the
// resolved rows so the builder never needs a `then` property. The query shape
// is picked by the selection: resolveActorLabel selects `{ name, email }`,
// resolveOwnerEmails selects `{ email }`.
const OWNER_ROWS = [{ email: "owner@example.com" }];
const ACTOR_ROWS = [{ name: "Ada Lovelace", email: "actor@example.com" }];

function ownerBuilder() {
  const builder = {
    from: () => builder,
    innerJoin: () => builder,
    where: () => Promise.resolve(OWNER_ROWS),
  };
  return builder;
}

function actorBuilder() {
  const builder = {
    from: () => builder,
    where: () => builder,
    limit: () => Promise.resolve(ACTOR_ROWS),
  };
  return builder;
}

const { sendSecurityAlertEmail } = vi.hoisted(() => ({
  sendSecurityAlertEmail: vi.fn().mockResolvedValue(true),
}));

vi.mock("@/lib/db", () => ({
  db: {
    select: (selection: Record<string, unknown>) =>
      "name" in selection ? actorBuilder() : ownerBuilder(),
  },
}));
vi.mock("@/lib/db/schema", () => ({
  member: { organizationId: {}, role: {}, userId: {} },
  users: { id: {}, email: {}, name: {} },
}));
vi.mock("@/lib/email", () => ({ sendSecurityAlertEmail }));

import { notifyOwnersOfHighRiskAction } from "@/lib/security/audit-owner-alert";

// Let the fire-and-forget promise chain settle.
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

const baseInput = {
  action: "wallet.private_key_exported",
  organizationId: "org-1",
  actorUserId: "user-1",
  actorLabel: null,
  resourceType: "wallet",
  when: new Date("2026-06-15T00:00:00.000Z"),
};

beforeEach(() => {
  sendSecurityAlertEmail.mockClear();
});

describe("notifyOwnersOfHighRiskAction", () => {
  it("emails each owner for a high-risk action, resolving the actor's name", async () => {
    notifyOwnersOfHighRiskAction(baseInput);
    await flush();

    expect(sendSecurityAlertEmail).toHaveBeenCalledTimes(1);
    expect(sendSecurityAlertEmail).toHaveBeenCalledWith({
      email: "owner@example.com",
      actionPhrase: "exported a wallet private key",
      actorLabel: "Ada Lovelace",
      when: baseInput.when,
      resourceType: "wallet",
    });
  });

  it("prefers a denormalized actorLabel over a user lookup", async () => {
    notifyOwnersOfHighRiskAction({
      ...baseInput,
      actorLabel: "KeeperHub admin",
    });
    await flush();

    expect(sendSecurityAlertEmail).toHaveBeenCalledWith(
      expect.objectContaining({ actorLabel: "KeeperHub admin" })
    );
  });

  it("is a no-op for a non-high-risk action", async () => {
    notifyOwnersOfHighRiskAction({ ...baseInput, action: "project.created" });
    await flush();
    expect(sendSecurityAlertEmail).not.toHaveBeenCalled();
  });

  it("is a no-op when there is no organization context", async () => {
    notifyOwnersOfHighRiskAction({ ...baseInput, organizationId: null });
    await flush();
    expect(sendSecurityAlertEmail).not.toHaveBeenCalled();
  });
});
