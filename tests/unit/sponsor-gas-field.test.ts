import { describe, expect, it } from "vitest";
import { resolveSponsorGas } from "@/lib/web3/sponsorship-feature-flag";
import { findActionById } from "@/plugins/registry";

/**
 * The "Sponsor gas" toggle has to appear on exactly the web3 write actions
 * whose step has a sponsored route, and nowhere else: a toggle on an action
 * that never tries sponsorship is a control that silently does nothing.
 */
const SPONSORABLE = [
  "web3/transfer-funds",
  "web3/transfer-token",
  "web3/approve-token",
  "web3/write-contract",
];

// Write actions with no sponsored path in their step: batch-write-contract
// signs every call itself, and the Solana and typed-data actions never reach
// Turnkey Gas Station.
const NOT_SPONSORABLE = [
  "web3/batch-write-contract",
  "web3/transfer-spl-token",
  "web3/send-raw-solana-instruction",
  "web3/call-solana-program-anchor",
  "web3/sign-typed-data",
];

function fieldKeys(actionType: string): string[] {
  const fields = findActionById(actionType)?.configFields ?? [];
  return fields
    .flatMap((field) => (field.type === "group" ? field.fields : [field]))
    .map((field) => ("key" in field ? field.key : ""));
}

describe("Sponsor gas field placement", () => {
  it.each(SPONSORABLE)("offers the toggle on %s", (actionType) => {
    expect(findActionById(actionType)).toBeDefined();
    expect(fieldKeys(actionType)).toContain("sponsorGas");
  });

  it.each(NOT_SPONSORABLE)("omits the toggle on %s", (actionType) => {
    expect(findActionById(actionType)).toBeDefined();
    expect(fieldKeys(actionType)).not.toContain("sponsorGas");
  });
});

describe("Sponsor gas field visibility", () => {
  it("gates every copy of the field on the selected network", () => {
    // Without this the toggle renders on chains the Gas Station never covered,
    // where it can only turn off something that was not there.
    for (const actionType of SPONSORABLE) {
      const fields = findActionById(actionType)?.configFields ?? [];
      const field = fields
        .flatMap((f) => (f.type === "group" ? f.fields : [f]))
        .find((f) => "key" in f && f.key === "sponsorGas");
      expect(field?.showWhen).toEqual({
        computed: "sponsorshipSupported",
        networkField: "network",
      });
    }
  });
});

describe("resolveSponsorGas", () => {
  it("defaults on so a node authored before the toggle keeps its route", () => {
    expect(resolveSponsorGas(undefined)).toBe(true);
    expect(resolveSponsorGas(null)).toBe(true);
  });

  it("reads both the boolean and the string the editor may persist", () => {
    expect(resolveSponsorGas(false)).toBe(false);
    expect(resolveSponsorGas("false")).toBe(false);
    expect(resolveSponsorGas(true)).toBe(true);
    expect(resolveSponsorGas("true")).toBe(true);
  });
});
