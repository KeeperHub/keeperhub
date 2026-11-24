import { describe, expect, it } from "vitest";

import {
  CAPABILITIES,
  Capability,
  capabilityAncestors,
  capabilityMatches,
  expandCapabilityPattern,
  getCapabilitiesByPlane,
  isCapability,
  isSelfReferentialCapability,
  PolicyPlane,
} from "@/lib/policy";

describe("capability registry", () => {
  it("keys every definition by its own id", () => {
    for (const [key, def] of Object.entries(CAPABILITIES)) {
      expect(def.id).toBe(key);
    }
  });

  it("splits cleanly into the two planes with nothing left over", () => {
    const data = getCapabilitiesByPlane(PolicyPlane.DATA);
    const control = getCapabilitiesByPlane(PolicyPlane.CONTROL);
    expect(data.length + control.length).toBe(Object.keys(CAPABILITIES).length);
    expect(data.some((id) => control.includes(id))).toBe(false);
  });

  it("marks value-moving data capabilities and no control ones", () => {
    expect(CAPABILITIES[Capability.ASSET_TRANSFER_TOKEN].valueMoving).toBe(
      true
    );
    expect(CAPABILITIES[Capability.CONTRACT_WRITE].valueMoving).toBe(true);
    expect(CAPABILITIES[Capability.CONTRACT_READ].valueMoving).toBe(false);
    for (const id of getCapabilitiesByPlane(PolicyPlane.CONTROL)) {
      expect(CAPABILITIES[id].valueMoving).toBe(false);
    }
  });

  it("gives every capability a non-empty guard dimension set", () => {
    // A coverage score is only computable against a closed enumeration; an
    // empty set would make the score decorative for that capability.
    for (const def of Object.values(CAPABILITIES)) {
      expect(def.guardDimensions.length).toBeGreaterThan(0);
    }
  });

  it("recognises known ids and rejects unknown ones", () => {
    expect(isCapability("asset.transfer.native")).toBe(true);
    expect(isCapability("asset.transfer.telepathy")).toBe(false);
  });
});

describe("capabilityAncestors", () => {
  it("derives the parent chain from the dotted path, nearest first", () => {
    expect(capabilityAncestors(Capability.PROTOCOL_LENDING_BORROW)).toEqual([
      "protocol.lending",
      "protocol",
    ]);
  });

  it("returns a single ancestor for a two-segment capability", () => {
    expect(capabilityAncestors(Capability.WORKFLOW_CREATE)).toEqual([
      "workflow",
    ]);
  });
});

describe("capabilityMatches", () => {
  it("matches an exact capability", () => {
    expect(
      capabilityMatches(
        "asset.transfer.native",
        Capability.ASSET_TRANSFER_NATIVE
      )
    ).toBe(true);
  });

  it("matches a deep wildcard at any depth below the prefix", () => {
    expect(
      capabilityMatches("asset.**", Capability.ASSET_TRANSFER_NATIVE)
    ).toBe(true);
    expect(
      capabilityMatches("protocol.**", Capability.PROTOCOL_LENDING_BORROW)
    ).toBe(true);
  });

  it("matches a bare ancestor path", () => {
    expect(
      capabilityMatches("protocol.lending", Capability.PROTOCOL_LENDING_BORROW)
    ).toBe(true);
  });

  it("limits a single-segment wildcard to exactly one level", () => {
    expect(
      capabilityMatches("asset.transfer.*", Capability.ASSET_TRANSFER_NATIVE)
    ).toBe(true);
    // protocol.lending.borrow is two levels below "protocol", so a single
    // wildcard must not reach it.
    expect(
      capabilityMatches("protocol.*", Capability.PROTOCOL_LENDING_BORROW)
    ).toBe(false);
  });

  it("does not match across sibling branches", () => {
    expect(
      capabilityMatches("asset.**", Capability.PROTOCOL_LENDING_BORROW)
    ).toBe(false);
    expect(
      capabilityMatches("workflow.**", Capability.INTEGRATION_UPDATE)
    ).toBe(false);
  });

  it("does not let a prefix that is not a path boundary match", () => {
    // "asset.transfer.native" must not be matched by "asset.transfer.nat".
    expect(
      capabilityMatches("asset.transfer.nat", Capability.ASSET_TRANSFER_NATIVE)
    ).toBe(false);
  });

  it("treats a bare wildcard as everything", () => {
    expect(capabilityMatches("**", Capability.POLICY_UPDATE)).toBe(true);
  });
});

describe("expandCapabilityPattern", () => {
  it("expands a branch to exactly its leaves", () => {
    const expanded = expandCapabilityPattern("asset.transfer.**");
    expect(expanded).toContain(Capability.ASSET_TRANSFER_NATIVE);
    expect(expanded).toContain(Capability.ASSET_TRANSFER_TOKEN);
    expect(expanded).not.toContain(Capability.ASSET_APPROVE);
  });

  it("expands the lending branch to all four operations", () => {
    const expanded = expandCapabilityPattern("protocol.lending.**");
    expect(expanded).toHaveLength(4);
    expect(expanded).toContain(Capability.PROTOCOL_LENDING_BORROW);
  });

  it("returns an empty list for a pattern that matches nothing", () => {
    expect(expandCapabilityPattern("nonsense.**")).toHaveLength(0);
  });
});

describe("isSelfReferentialCapability", () => {
  it("flags capabilities that grant authority over the policy system itself", () => {
    // Uniform treatment is the trap: without flagging these, a rule permitting
    // organization changes silently permits rewriting the rules that constrain
    // the person making the change.
    expect(isSelfReferentialCapability(Capability.POLICY_UPDATE)).toBe(true);
    expect(isSelfReferentialCapability(Capability.MEMBER_UPDATE)).toBe(true);
    expect(isSelfReferentialCapability(Capability.APIKEY_CREATE)).toBe(true);
    expect(isSelfReferentialCapability(Capability.ADDRESSBOOK_CREATE)).toBe(
      true
    );
    expect(isSelfReferentialCapability(Capability.WALLET_ROLE_UPDATE)).toBe(
      true
    );
  });

  it("does not flag ordinary capabilities", () => {
    expect(isSelfReferentialCapability(Capability.WORKFLOW_CREATE)).toBe(false);
    expect(isSelfReferentialCapability(Capability.ASSET_TRANSFER_TOKEN)).toBe(
      false
    );
  });
});
