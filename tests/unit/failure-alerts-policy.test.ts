import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ db: {} }));

const {
  DEFAULT_ORG_POLICY,
  isMuted,
  mergePolicy,
  resolveRecipientEmails,
} = await import("@/lib/notifications/failure-alerts/policy");
const { isFailureAlertsEnabledForOrg } = await import(
  "@/lib/notifications/failure-alerts/rollout"
);

type Override = Parameters<typeof mergePolicy>[2];

function override(patch: Partial<NonNullable<Override>>): NonNullable<Override> {
  return {
    workflowId: "wf",
    organizationId: "org",
    threshold: null,
    timeLimitMinutes: null,
    recipientUserIds: null,
    customChannels: false,
    mutedUntil: null,
    muteUntilSuccess: false,
    muteReason: null,
    mutedBy: null,
    updatedBy: null,
    updatedAt: new Date(),
    ...patch,
  };
}

const orgChannel = {
  id: "c-org",
  kind: "slack" as const,
  integrationId: "i1",
  destination: "#ops",
  role: "always" as const,
  pausedAt: null,
};
const wfChannel = { ...orgChannel, id: "c-wf", kind: "discord" as const };

describe("mergePolicy", () => {
  it("is the default for an org nobody configured", () => {
    const policy = mergePolicy(DEFAULT_ORG_POLICY, [], null, []);
    expect(policy.threshold).toBe(5);
    expect(policy.timeLimitMinutes).toBeNull();
    expect(policy.recipientUserIds).toBeNull();
    expect(policy.source).toBe("default");
  });

  it("keeps following the org for fields the override leaves alone", () => {
    const org = { ...DEFAULT_ORG_POLICY, isDefault: false, threshold: 3 };
    const policy = mergePolicy(
      org,
      [orgChannel],
      override({ timeLimitMinutes: 60 }),
      []
    );
    expect(policy.threshold).toBe(3);
    expect(policy.timeLimitMinutes).toBe(60);
    expect(policy.channels).toEqual([orgChannel]);
    expect(policy.source).toBe("custom");
  });

  it("lets a workflow turn the time limit off", () => {
    const org = { ...DEFAULT_ORG_POLICY, timeLimitMinutes: 360 };
    const policy = mergePolicy(org, [], override({ timeLimitMinutes: 0 }), []);
    expect(policy.timeLimitMinutes).toBeNull();
  });

  it("uses the workflow's own channels when it has custom channels", () => {
    const policy = mergePolicy(
      DEFAULT_ORG_POLICY,
      [orgChannel],
      override({ customChannels: true }),
      [wfChannel]
    );
    expect(policy.channels).toEqual([wfChannel]);
  });

  it("treats a mute-only override as following the org", () => {
    const policy = mergePolicy(
      DEFAULT_ORG_POLICY,
      [],
      override({ mutedUntil: new Date("2030-01-01") }),
      []
    );
    expect(policy.source).toBe("default");
    expect(isMuted(policy, new Date("2029-01-01"))).toBe(true);
    expect(isMuted(policy, new Date("2031-01-01"))).toBe(false);
  });
});

describe("resolveRecipientEmails", () => {
  const members = [
    { userId: "owner", role: "owner", email: "o@x.dev", name: null, deliverable: "o@x.dev" },
    { userId: "admin", role: "admin", email: "a@x.dev", name: null, deliverable: "a@x.dev" },
    { userId: "wallet", role: "member", email: "0x1@wallet.keeperhub.com", name: null, deliverable: null },
    { userId: "dup", role: "member", email: "o@x.dev", name: null, deliverable: "o@x.dev" },
  ];

  it("defaults to the owners", () => {
    expect(resolveRecipientEmails(null, members)).toEqual(["o@x.dev"]);
  });

  it("uses chosen members and drops duplicates", () => {
    expect(
      resolveRecipientEmails(["admin", "dup", "owner"], members).sort()
    ).toEqual(["a@x.dev", "o@x.dev"]);
  });

  it("falls back to the owners when nobody chosen can be reached", () => {
    expect(resolveRecipientEmails(["wallet", "gone"], members)).toEqual([
      "o@x.dev",
    ]);
  });

  it("falls back to admins when no owner can be reached", () => {
    const walletOwner = [
      { ...members[0], deliverable: null },
      members[1],
    ];
    expect(resolveRecipientEmails(null, walletOwner)).toEqual(["a@x.dev"]);
  });

  it("returns nobody when nobody can be reached", () => {
    expect(resolveRecipientEmails(null, [members[2]])).toEqual([]);
  });
});

describe("isFailureAlertsEnabledForOrg", () => {
  it.each([
    [undefined, false],
    ["off", false],
    ["all", true],
    ["orgs:org-a, org-b", true],
    ["orgs:org-b", false],
    ["percent:100", true],
    ["percent:0", false],
    ["nonsense", false],
  ])("rollout %s -> %s for org-a", (rollout, expected) => {
    expect(isFailureAlertsEnabledForOrg("org-a", rollout)).toBe(expected);
  });

  it("only ever adds organizations as the percentage grows", () => {
    const ids = Array.from({ length: 200 }, (_, i) => `org-${i}`);
    const at10 = ids.filter((id) => isFailureAlertsEnabledForOrg(id, "percent:10"));
    const at50 = new Set(
      ids.filter((id) => isFailureAlertsEnabledForOrg(id, "percent:50"))
    );
    expect(at10.length).toBeGreaterThan(0);
    for (const id of at10) {
      expect(at50.has(id)).toBe(true);
    }
  });
});
