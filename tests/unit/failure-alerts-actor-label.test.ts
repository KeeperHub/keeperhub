import { describe, expect, it } from "vitest";
import {
  accountLabel,
  actorLabel,
} from "@/lib/notifications/failure-alerts/actor-label";
import { requiredManagers } from "@/lib/notifications/failure-alerts/constants";
import { pauseActorName } from "@/lib/notifications/failure-alerts/messages";

describe("who acted", () => {
  it("names a person by name, else by role, members included", () => {
    expect(pauseActorName({ name: "Dana", role: "member" })).toBe("Dana");
    expect(pauseActorName({ name: "dana@x.com", role: "member" })).toBe(
      "A member"
    );
    expect(pauseActorName({ name: null, role: "owner" })).toBe("An owner");
    expect(pauseActorName({ name: "", role: "admin" })).toBe("An admin");
  });

  it("adds the account, shortens a wallet, and uses the account alone for a role", () => {
    const wallet = `0x${"ab".repeat(20)}`;
    expect(actorLabel("Dana", "dana@x.com")).toBe("Dana (dana@x.com)");
    expect(actorLabel("An admin", wallet)).toBe(accountLabel(wallet));
    expect(accountLabel(wallet).length).toBeLessThan(42);
    expect(actorLabel("Dana", null)).toBe("Dana");
    expect(actorLabel(null, null)).toBeNull();
  });
});

describe("requiredManagers", () => {
  const owner = { role: "owner", email: false };
  const admin = { role: "admin", email: true };
  const member = { role: "member", email: true };
  it("keeps the owners and admins who can get email, or all of them when none can", () => {
    expect(requiredManagers([owner, admin, member], (m) => m.email)).toEqual([
      admin,
    ]);
    expect(
      requiredManagers([owner, { ...admin, email: false }], (m) => m.email)
    ).toHaveLength(2);
  });
});
