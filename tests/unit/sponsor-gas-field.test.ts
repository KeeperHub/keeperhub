import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
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

/**
 * Any step that reaches for the sponsored route has to honour the toggle. The
 * gate is one conjunct in an `if`, so a new sponsored write action can pick up
 * the sponsored path and silently ignore the author's choice - which reads as
 * the toggle being broken rather than missing.
 */
describe("every sponsored step consults the toggle", () => {
  const stepsDir = join(import.meta.dirname, "../../plugins/web3/steps");
  const sponsoredSteps = readdirSync(stepsDir).filter((file) =>
    readFileSync(join(stepsDir, file), "utf8").includes(
      "isGasSponsorshipEnabled("
    )
  );

  it("finds the sponsored steps to check", () => {
    expect(sponsoredSteps.length).toBeGreaterThan(0);
  });

  it.each(sponsoredSteps)("%s gates on resolveSponsorGas", (file) => {
    expect(readFileSync(join(stepsDir, file), "utf8")).toContain(
      "resolveSponsorGas(sponsorGas)"
    );
  });
});
