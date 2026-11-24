import { describe, expect, it } from "vitest";
import { PolicyEffect } from "@/lib/policy";
import { StatementTarget } from "@/lib/policy/catalog";
import {
  ActorScope,
  CounterpartyScope,
  describeStatement,
  emptyStatement,
  SelectorScope,
  type StatementFormValue,
} from "@/lib/policy/ui";

const POOL = "0xa238dd80c259a72e81d7e4664a9801593f98d1c5";

function rule(over: Partial<StatementFormValue>): StatementFormValue {
  const base = emptyStatement(0);
  return {
    ...base,
    ...over,
    resource: { ...base.resource, ...(over.resource ?? {}) },
  };
}

describe("what a rule says it does", () => {
  it("names the contract it acts on", () => {
    const summary = describeStatement(
      rule({
        resource: {
          chainId: 8453,
          address: POOL,
          selectors: [],
          selectorScope: SelectorScope.THESE,
        },
      })
    );
    expect(summary.verb).toBe("Allows");
    expect(summary.headline).toContain("calls to");
  });

  it("says refuses for a deny", () => {
    expect(describeStatement(rule({ effect: PolicyEffect.DENY })).verb).toBe(
      "Refuses"
    );
  });

  it("describes a control-plane rule by what it governs", () => {
    const summary = describeStatement(
      rule({
        target: StatementTarget.WALLET,
        controlCapabilities: ["wallet.role.update"],
      })
    );
    expect(summary.headline).toContain("safes");
  });
});

describe("exceptions are marked as exceptions", () => {
  it("marks a carved-out function", () => {
    const summary = describeStatement(
      rule({
        resource: {
          chainId: 8453,
          address: POOL,
          selectors: ["0x617ba037"],
          selectorScope: SelectorScope.EXCEPT,
        },
      })
    );
    const clause = summary.clauses.find((c) => c.exception);
    expect(clause?.text).toBe("except 1 function");
  });

  it("does not mark the same functions when they are what the rule covers", () => {
    const summary = describeStatement(
      rule({
        resource: {
          chainId: 8453,
          address: POOL,
          selectors: ["0x617ba037"],
          selectorScope: SelectorScope.THESE,
        },
      })
    );
    // The same list means the opposite thing, so it must not read the same way.
    expect(summary.clauses.some((c) => c.exception)).toBe(false);
    expect(summary.clauses[0]?.text).toBe("on 1 function");
  });

  it("marks excluded counterparties", () => {
    const summary = describeStatement(
      rule({
        counterparties: ["0x1", "0x2"],
        counterpartyScope: CounterpartyScope.EXCEPT,
      })
    );
    expect(summary.clauses.find((c) => c.exception)?.text).toBe(
      "except 2 counterparties"
    );
  });

  it("reads an allow-list as a narrowing, not an exception", () => {
    const summary = describeStatement(
      rule({
        counterparties: ["0x1"],
        counterpartyScope: CounterpartyScope.ONLY,
      })
    );
    expect(summary.clauses.some((c) => c.exception)).toBe(false);
    expect(summary.clauses[0]?.text).toBe("only to 1 counterparty");
  });

  it("says nothing about counterparties when the rule places no restriction", () => {
    expect(
      describeStatement(
        rule({
          counterparties: ["0x1"],
          counterpartyScope: CounterpartyScope.ANY,
        })
      ).clauses
    ).toHaveLength(0);
  });
});

describe("the rest of the sentence", () => {
  it("names who it applies to", () => {
    const summary = describeStatement(
      rule({ actorScope: ActorScope.ROLES, actorRoles: ["owner", "admin"] })
    );
    expect(summary.clauses[0]?.text).toBe("only for owner and admin");
  });

  it("states both limits", () => {
    const summary = describeStatement(
      rule({ maxUsd: "25000", dailyUsd: "100000" })
    );
    expect(summary.clauses[0]?.text).toBe(
      "at most 25000 per action, 100000 per day"
    );
  });
});
