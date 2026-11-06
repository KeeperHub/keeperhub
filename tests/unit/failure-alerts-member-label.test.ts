import { describe, expect, it } from "vitest";
import {
  isLastRecipient,
  lastRecipientNote,
  muteSentence,
} from "@/components/failure-alerts/member-label";
import {
  accountLabel,
  actorLabel,
} from "@/lib/notifications/failure-alerts/actor-label";

const owner = { userId: "o", role: "owner", reachable: true };
const admin = { userId: "a", role: "admin", reachable: true };
const member = { userId: "m", role: "member", reachable: true };
const all = [owner, admin, member];

describe("who must stay on alert emails", () => {
  it("keeps the only chosen person", () => {
    expect(isLastRecipient(member, ["m"], all)).toBe(true);
  });

  it("keeps the last owner or admin, but not a plain member beside them", () => {
    expect(isLastRecipient(owner, ["o", "m"], all)).toBe(true);
    expect(isLastRecipient(member, ["o", "m"], all)).toBe(false);
  });

  it("lets an owner go while an admin stays", () => {
    expect(isLastRecipient(owner, ["o", "a"], all)).toBe(false);
    expect(isLastRecipient(admin, ["o", "a"], all)).toBe(false);
  });

  it("keeps the last owner or admin who can get email, even beside one who cannot", () => {
    const walletAdmin = { userId: "w", role: "admin", reachable: false };
    const team = [owner, walletAdmin, member];
    expect(isLastRecipient(owner, ["o", "w", "m"], team)).toBe(true);
    expect(isLastRecipient(walletAdmin, ["o", "w", "m"], team)).toBe(false);
  });

  it("never blocks someone who is not chosen", () => {
    expect(isLastRecipient(admin, ["o"], all)).toBe(false);
  });

  it("says why", () => {
    expect(lastRecipientNote(false)).toBe(
      "An owner or admin who can get email must always get alerts. Tick another one first."
    );
  });
});

describe("accountLabel", () => {
  it("shortens a wallet address and keeps an email", () => {
    expect(accountLabel(`0x${"ab".repeat(20)}`)).toMatch(/^0xabab.*abab$/i);
    expect(accountLabel(`0x${"ab".repeat(20)}`).length).toBeLessThan(42);
    expect(accountLabel("dana@example.com")).toBe("dana@example.com");
  });
});

describe("actorLabel", () => {
  it("names the person with their account, which tells apart shared names", () => {
    expect(actorLabel("Dana", "dana@example.com")).toBe(
      "Dana (dana@example.com)"
    );
  });

  it("lets the account stand in for a name that is only a role", () => {
    expect(actorLabel("An owner", "dana@example.com")).toBe("dana@example.com");
    expect(actorLabel("An admin", null)).toBe("An admin");
  });

  it("does not repeat a name that is the account", () => {
    expect(actorLabel("dana@example.com", "dana@example.com")).toBe(
      "dana@example.com"
    );
    expect(actorLabel(null, null)).toBeNull();
  });
});

describe("muteSentence", () => {
  it("says who, until when and why, the same on every surface", () => {
    const until = "2026-11-13T12:00:00.000Z";
    const timed = muteSentence({
      by: "Dana",
      account: "dana@example.com",
      untilItWorks: false,
      mutedUntil: until,
      reason: "RPC move",
    });
    expect(timed).toMatch(
      /^Muted by Dana \(dana@example\.com\) until .+: RPC move$/
    );
    const works = muteSentence({
      by: "An admin",
      account: null,
      untilItWorks: true,
      mutedUntil: until,
      reason: null,
    });
    expect(works).toMatch(
      /^Muted by An admin until it works again \(at most until .+\)$/
    );
  });
});
