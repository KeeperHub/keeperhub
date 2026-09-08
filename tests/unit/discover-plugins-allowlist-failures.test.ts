import { describe, expect, it } from "vitest";
import {
  loadPluginAllowlist,
  PluginAllowlistError,
} from "../../scripts/discover-plugins";

/**
 * loadPluginAllowlist decides which plugins ship. Three silent failure modes
 * used to exist: malformed JSON widened the set to everything, and a missing
 * or misspelled "plugins" key emptied it to nothing - both on a green exit
 * code. These tests pin the loader to failing closed instead: a present but
 * untrustworthy file throws, and only an absent file still means "no
 * restriction declared".
 */

/** The error, or a failure saying it never threw - never a union to narrow. */
function failureFrom(deps: Parameters<typeof loadPluginAllowlist>[0]) {
  try {
    loadPluginAllowlist(deps);
  } catch (error) {
    if (error instanceof PluginAllowlistError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected loadPluginAllowlist to throw, it returned");
}

describe("loadPluginAllowlist", () => {
  it("returns null when the file does not exist, meaning no restriction", () => {
    expect(
      loadPluginAllowlist({
        exists: () => false,
      })
    ).toBeNull();
  });

  it("throws rather than widening the set when the file is malformed JSON", () => {
    const error = failureFrom({
      exists: () => true,
      readFile: () => "{ not valid json",
    });

    expect(error).toBeInstanceOf(PluginAllowlistError);
  });

  it('throws rather than emptying the set when "plugins" is missing', () => {
    const error = failureFrom({
      exists: () => true,
      readFile: () => JSON.stringify({ description: "no plugins key" }),
    });

    expect(error.message).toContain('"plugins"');
  });

  it('throws when "plugins" is not an array', () => {
    const error = failureFrom({
      exists: () => true,
      readFile: () => JSON.stringify({ plugins: "web3" }),
    });

    expect(error.message).toContain("array");
  });

  it('throws when "plugins" contains a non-string entry', () => {
    const error = failureFrom({
      exists: () => true,
      readFile: () => JSON.stringify({ plugins: ["web3", 42] }),
    });

    expect(error.message).toContain("string");
  });

  it('throws when "plugins" contains duplicate entries', () => {
    const error = failureFrom({
      exists: () => true,
      readFile: () => JSON.stringify({ plugins: ["web3", "web3"] }),
    });

    expect(error.message).toContain("duplicate");
  });

  it("accepts an explicit empty list as deliberately enabling nothing", () => {
    expect(
      loadPluginAllowlist({
        exists: () => true,
        readFile: () => JSON.stringify({ plugins: [] }),
      })
    ).toEqual([]);
  });

  it("filters exactly as today when the file is valid", () => {
    expect(
      loadPluginAllowlist({
        exists: () => true,
        readFile: () =>
          JSON.stringify({ plugins: ["web3", "discord", "sendgrid"] }),
      })
    ).toEqual(["web3", "discord", "sendgrid"]);
  });
});
