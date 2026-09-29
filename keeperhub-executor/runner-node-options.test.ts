import { describe, expect, it } from "vitest";
import {
  assertRunnerNodeOptions,
  buildRunnerNodeOptions,
  RUNNER_BASE_NODE_OPTIONS,
} from "./runner-node-options";

describe("buildRunnerNodeOptions", () => {
  it("is exactly the base flags when no extra options are set", () => {
    expect(buildRunnerNodeOptions("")).toBe("--max-old-space-size=512");
    expect(buildRunnerNodeOptions("   ")).toBe(RUNNER_BASE_NODE_OPTIONS);
  });

  it("appends trimmed extra options after the base flags", () => {
    expect(buildRunnerNodeOptions("  --no-network-family-autoselection \n")).toBe(
      "--max-old-space-size=512 --no-network-family-autoselection"
    );
  });
});

describe("assertRunnerNodeOptions", () => {
  it("accepts empty extra options without starting Node", () => {
    expect(() => assertRunnerNodeOptions("")).not.toThrow();
  });

  it("accepts a flag Node allows in NODE_OPTIONS", () => {
    expect(() =>
      assertRunnerNodeOptions("--no-network-family-autoselection")
    ).not.toThrow();
  });

  it("rejects a flag Node does not know", () => {
    expect(() => assertRunnerNodeOptions("--no-such-node-flag")).toThrow(
      /RUNNER_EXTRA_NODE_OPTIONS is rejected by Node/
    );
  });

  it("rejects a flag Node does not allow in NODE_OPTIONS", () => {
    expect(() => assertRunnerNodeOptions("--version")).toThrow(
      /--version is not allowed in NODE_OPTIONS/
    );
  });
});
