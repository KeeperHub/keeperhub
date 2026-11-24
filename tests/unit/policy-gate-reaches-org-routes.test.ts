import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The policy gate identifies its principal from the resolver's own result, and
 * returns the context untouched when it cannot. A resolver that does not carry
 * a userId therefore silently ungoverns every route built on it, whatever the
 * route manifest declares, including the fail-closed refusal for a route the
 * manifest does not classify at all.
 *
 * That is a defect nothing else notices: the route still works, the manifest
 * still reads as governed, and no decision is ever recorded.
 */
const SOURCE = readFileSync("lib/middleware/auth-helpers.ts", "utf8");

describe("what the organization resolver hands the policy gate", () => {
  it("carries a userId on its type", () => {
    const type = SOURCE.slice(
      SOURCE.indexOf("export type OrganizationAuthContext"),
      SOURCE.indexOf("export type OrganizationAuthContext") + 700
    );
    expect(type).toContain("userId: string;");
  });

  it("returns one from every branch that authenticates somebody", () => {
    const fn = SOURCE.slice(
      SOURCE.indexOf("async function resolveOrganizationIdInner"),
      SOURCE.indexOf("export async function resolveOrganizationId(")
    );

    // Only the branches that resolve somebody: a refusal carries no principal
    // and needs none. authMethod is what marks one, since the refusals mention
    // an organization in their message text.
    const returns = fn.split("return {").slice(1);
    const authenticated = returns.filter((r) =>
      r.slice(0, 200).includes("authMethod")
    );
    expect(authenticated.length).toBeGreaterThanOrEqual(3);
    for (const branch of authenticated) {
      expect(branch).toContain("userId");
    }
  });
});
