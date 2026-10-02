import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { summariseGroup } from "@/lib/workflow/editor/group-summary";
import pagerDutyPlugin from "@/plugins/pagerduty";
import { type ActionConfigFieldBase, isFieldGroup } from "@/plugins/registry";

function field(
  key: string,
  extra: Partial<ActionConfigFieldBase> = {}
): ActionConfigFieldBase {
  return {
    key,
    label: key,
    type: "text",
    ...extra,
  } as ActionConfigFieldBase;
}

/**
 * What a collapsed group says about the values hidden inside it.
 *
 * The count has to mean "somebody chose this", not "this field has a value".
 * A badge that appears on every group of every node because the defaults are
 * populated tells nobody anything, and it is worse than no badge: it trains
 * people to ignore the one group that really does hold a setting.
 */
describe("summarising a collapsed config group", () => {
  it("says nothing about a group nobody has touched", () => {
    expect(summariseGroup([field("a"), field("b")], {})).toEqual({
      count: 0,
      labels: [],
    });
  });

  it("counts a value somebody entered, and names it", () => {
    const summary = summariseGroup(
      [field("component", { label: "Component" }), field("group")],
      { component: "vault-monitor" }
    );
    expect(summary).toEqual({ count: 1, labels: ["Component"] });
  });

  /** The case that would otherwise badge every node in the product. */
  it("does not count a field sitting at its declared default", () => {
    expect(
      summariseGroup([field("retries", { defaultValue: "2" })], {
        retries: "2",
      }).count
    ).toBe(0);
  });

  it("counts that same field once it is changed", () => {
    expect(
      summariseGroup([field("retries", { defaultValue: "2" })], {
        retries: "4",
      }).count
    ).toBe(1);
  });

  /**
   * A select writes the string "false" where a plugin may declare the default
   * as the string "true"; the comparison is on what the control produced.
   */
  it("counts a switch turned away from its default", () => {
    const failOnError = field("failOnError", {
      type: "fail-on-error-switch",
      defaultValue: "true",
    });
    expect(summariseGroup([failOnError], { failOnError: "true" }).count).toBe(
      0
    );
    expect(summariseGroup([failOnError], { failOnError: "false" }).count).toBe(
      1
    );
  });

  it("treats blank and whitespace as nothing entered", () => {
    expect(
      summariseGroup([field("a"), field("b")], { a: "", b: "   " }).count
    ).toBe(0);
  });

  /**
   * Preview panels and test buttons render, they do not collect. Counting
   * them would put a permanent badge on any group holding one.
   */
  it("ignores fields that only render", () => {
    expect(
      summariseGroup(
        [
          field("pagerdutyPreview", { type: "pagerduty-preview" }),
          field("pagerdutyTestNode", { type: "pagerduty-test-node" }),
          field("pagerdutyFromEmailNotice", {
            type: "pagerduty-from-email-notice",
          }),
        ],
        {
          pagerdutyPreview: "x",
          pagerdutyTestNode: "x",
          pagerdutyFromEmailNotice: "x",
        }
      ).count
    ).toBe(0);
  });

  /**
   * A hidden field keeps whatever was stored before its condition stopped
   * holding. The form is not showing it, so the group should not claim it.
   */
  it("ignores a field its own condition is hiding", () => {
    const conditional = field("dedupKey", {
      showWhen: { field: "mode", equals: "manual" },
    });
    expect(
      summariseGroup([conditional], { mode: "auto", dedupKey: "leftover" })
        .count
    ).toBe(0);
    expect(
      summariseGroup([conditional], { mode: "manual", dedupKey: "leftover" })
        .count
    ).toBe(1);
  });

  it("keeps the labels in the order the fields are declared", () => {
    expect(
      summariseGroup(
        [
          field("a", { label: "Alpha" }),
          field("b", { label: "Beta" }),
          field("c", { label: "Gamma" }),
        ],
        { c: "3", a: "1" }
      ).labels
    ).toEqual(["Alpha", "Gamma"]);
  });
});

/**
 * The same thing against the real plugin rather than fixtures, because the
 * question that matters is whether the badge is quiet on a node somebody has
 * just dropped on the canvas - and that depends on what the plugin declares,
 * not on what a fixture declares.
 */
describe("the PagerDuty node's own groups", () => {
  const groups = pagerDutyPlugin.actions.flatMap((action) =>
    (action.configFields ?? [])
      .filter((field) => isFieldGroup(field))
      .map(
        (field) => [`${action.slug} / ${field.label}`, field.fields] as const
      )
  );

  it("has groups to summarise at all", () => {
    expect(groups.length).toBeGreaterThan(5);
  });

  it.each(groups.map(([name]) => name))(
    "says nothing on a fresh node: %s",
    (name) => {
      const entry = groups.find(([groupName]) => groupName === name);
      expect(summariseGroup(entry?.[1] ?? [], {})).toEqual({
        count: 0,
        labels: [],
      });
    }
  );

  /**
   * Retry attempts and Retry delay declare no `defaultValue`; their documented
   * defaults are applied by the step and declared here only as `example`.
   * `generateAIActionPrompts` seeds `example` into every generated node, so
   * counting those made every AI-built node badge "2 set" on a group nobody
   * had touched.
   */
  it("counts what somebody actually entered in Advanced", () => {
    const action = pagerDutyPlugin.actions.find(
      (one) => one.slug === "trigger-incident"
    );
    const advanced = (action?.configFields ?? []).find(
      (field) => isFieldGroup(field) && field.label === "Advanced"
    );
    if (!(advanced && isFieldGroup(advanced))) {
      throw new Error("trigger-incident has no Advanced group any more");
    }
    expect(
      summariseGroup(advanced.fields, {
        consecutiveRuns: "3",
        retryAttempts: "2",
      })
    ).toEqual({
      count: 1,
      labels: ["Consecutive runs before paging"],
    });

    // Changed away from the documented default, it is a choice again.
    expect(summariseGroup(advanced.fields, { retryAttempts: "5" })).toEqual({
      count: 1,
      labels: ["Retry attempts"],
    });

    // The switch at its declared default stays uncounted even here.
    expect(summariseGroup(advanced.fields, { failOnError: "true" }).count).toBe(
      0
    );
  });
});
