import { afterEach, describe, expect, it, vi } from "vitest";

const { mockLogWarn } = vi.hoisted(() => ({ mockLogWarn: vi.fn() }));
vi.mock("@/lib/logging", () => ({ logWarn: mockLogWarn }));

import {
  isEnabledForOrg,
  isRolloutActive,
  splitByRollout,
} from "@/lib/rollout";
import { isBundleSendEnabledForOrg } from "@/lib/web3/bundles/rollout";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("isEnabledForOrg", () => {
  it.each([
    [undefined, false],
    ["", false],
    ["off", false],
    [" all ", true],
    ["orgs:org-a, org-b", true],
    ["orgs:org-b", false],
    ["orgs:", false],
    ["percent:100", true],
    ["percent:0", false],
    ["percent:abc", false],
    ["percent:0x64", false],
    ["percent:1e2", false],
    ["percent: 100", false],
    ["percent:100abc", false],
    ["percent:-5", false],
    ["nonsense", false],
    ["on", false],
    ["true", false],
    ["ALL", false],
  ])("rollout %s -> %s for org-a", (rollout, expected) => {
    expect(isEnabledForOrg("org-a", rollout)).toBe(expected);
  });

  // The parser before it was shared, kept here as the reference.
  function previousParser(org: string, rollout: string | undefined): boolean {
    const value = rollout?.trim() ?? "";
    if (value === "" || value === "off") {
      return false;
    }
    if (value === "all") {
      return true;
    }
    if (value.startsWith("orgs:")) {
      return value
        .slice("orgs:".length)
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean)
        .includes(org);
    }
    if (value.startsWith("percent:")) {
      const percent = Number(value.slice("percent:".length));
      if (!Number.isFinite(percent) || percent <= 0) {
        return false;
      }
      let hash = 0x81_1c_9d_c5;
      for (let i = 0; i < org.length; i += 1) {
        hash ^= org.charCodeAt(i);
        hash = Math.imul(hash, 0x01_00_01_93);
      }
      return (hash >>> 0) % 100 < Math.min(percent, 100);
    }
    return false;
  }

  it.each([
    "off",
    "",
    "all",
    " all ",
    "orgs:org-1",
    "orgs:org-1, org-7,org-42",
    "percent:0",
    "percent:1",
    "percent:10",
    "percent:12.5",
    "percent:50",
    "percent:99",
    "percent:100",
    "percent:150",
  ])("gives failure alerts the same orgs as before for %j", (rollout) => {
    for (let i = 0; i < 300; i += 1) {
      const org = `org-${i}`;
      expect(isEnabledForOrg(org, rollout)).toBe(previousParser(org, rollout));
    }
  });

  it("only ever adds organizations as the percentage grows", () => {
    const ids = Array.from({ length: 200 }, (_, i) => `org-${i}`);
    const at10 = ids.filter((id) => isEnabledForOrg(id, "percent:10"));
    const at50 = new Set(ids.filter((id) => isEnabledForOrg(id, "percent:50")));
    expect(at10.length).toBeGreaterThan(0);
    for (const id of at10) {
      expect(at50.has(id)).toBe(true);
    }
  });
});

describe("isRolloutActive", () => {
  it.each([
    [undefined, false],
    [" ", false],
    ["off", false],
    ["all", true],
    ["orgs:x", true],
    ["percent:5", true],
    ["orgs:", false],
    ["percent:0", false],
    ["percent:0x10", false],
    ["on", false],
    ["true", false],
    ["ALL", false],
    ["garbage", false],
  ])("%s -> %s", (rollout, expected) => {
    expect(isRolloutActive(rollout)).toBe(expected);
  });
});

describe("splitByRollout", () => {
  it("keeps rows of orgs in the rollout; rows with no org are dropped", () => {
    const rows = [{ org: "a" }, { org: "b" }, { org: undefined }];
    const { kept, dropped } = splitByRollout(rows, (r) => r.org, "orgs:a");
    expect(kept).toEqual([{ org: "a" }]);
    expect(dropped).toEqual([{ org: "b" }, { org: undefined }]);
  });
});

describe("isBundleSendEnabledForOrg", () => {
  it("is off when BUNDLE_SEND_ROLLOUT is unset", () => {
    vi.stubEnv("BUNDLE_SEND_ROLLOUT", "");
    expect(isBundleSendEnabledForOrg("org-a")).toBe(false);
  });

  it("reads BUNDLE_SEND_ROLLOUT, not the failure-alerts setting", () => {
    vi.stubEnv("FAILURE_ALERTS_ROLLOUT", "all");
    vi.stubEnv("BUNDLE_SEND_ROLLOUT", "orgs:org-a");
    expect(isBundleSendEnabledForOrg("org-a")).toBe(true);
    expect(isBundleSendEnabledForOrg("org-b")).toBe(false);
  });

  it("accepts an explicit value", () => {
    expect(isBundleSendEnabledForOrg("org-a", "all")).toBe(true);
    expect(isBundleSendEnabledForOrg("org-a", "off")).toBe(false);
  });

  it("refuses a percent, with one warning", () => {
    expect(isBundleSendEnabledForOrg("org-a", "percent:100")).toBe(false);
    expect(isBundleSendEnabledForOrg("org-a", " percent:100")).toBe(false);
    expect(mockLogWarn).toHaveBeenCalledTimes(1);
  });
});
