import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ db: {} }));

const {
  historyToCsv,
  isReachable,
  parseThreshold,
  parseTimeLimit,
  SettingsError,
} = await import("@/lib/notifications/failure-alerts/settings");
const { memberLabel } = await import("@/components/failure-alerts/member-label");

describe("parseThreshold", () => {
  it.each([1, 5, 20, "7"])("accepts %s", (value) => {
    expect(parseThreshold(value)).toBe(Number(value));
  });

  it.each([0, 21, 2.5, "x", null])("rejects %s", (value) => {
    expect(() => parseThreshold(value)).toThrow(SettingsError);
  });
});

describe("parseTimeLimit", () => {
  it("treats empty and zero as off", () => {
    expect(parseTimeLimit(null)).toBeNull();
    expect(parseTimeLimit(undefined)).toBeNull();
    expect(parseTimeLimit(0)).toBeNull();
  });

  it("accepts the offered limits only", () => {
    expect(parseTimeLimit(60)).toBe(60);
    expect(parseTimeLimit("360")).toBe(360);
    expect(() => parseTimeLimit(45)).toThrow(SettingsError);
  });
});

describe("isReachable", () => {
  it("is reachable with an email or a live channel, not with paused ones", () => {
    expect(isReachable(["a@x.dev"], [])).toBe(true);
    expect(isReachable([], [{ pausedAt: null }])).toBe(true);
    expect(isReachable([], [{ pausedAt: "2026-10-01T00:00:00Z" }])).toBe(false);
    expect(isReachable([], [])).toBe(false);
  });
});

describe("historyToCsv", () => {
  it("quotes commas and defuses spreadsheet formulas in names", () => {
    const csv = historyToCsv([
      {
        id: "d1",
        createdAt: "2026-10-28T12:00:00.000Z",
        deliveredAt: null,
        kind: "alert",
        channel: "email",
        recipient: "a@x.dev",
        connectionName: null,
        isBackup: false,
        state: "failed",
        attempts: 3,
        lastStatus: 503,
        lastError: "Service, unavailable",
        workflows: [{ id: "w", name: "=HYPERLINK(\"x\")" }],
      },
    ]);
    const [header, row] = csv.trim().split("\n");
    expect(header.startsWith("time_utc,type,channel")).toBe(true);
    expect(row).toContain('"Service, unavailable"');
    expect(row).toContain(`"'=HYPERLINK(""x"")"`);
  });
});

describe("memberLabel", () => {
  it("shows a wallet member by address rather than the synthetic login", () => {
    expect(
      memberLabel({
        email: "0x7a3f0000000000000000000000000000000091c2@wallet.keeperhub.com",
        name: null,
        userId: "u",
      })
    ).toBe("0x7a3f...91c2");
    expect(memberLabel({ email: "a@x.dev", name: null, userId: "u" })).toBe(
      "a@x.dev"
    );
  });
});
