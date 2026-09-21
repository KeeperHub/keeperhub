import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { summariseGroup } from "@/lib/workflow/editor/group-summary";
import pagerDutyPlugin from "@/plugins/pagerduty";
import { buildExampleConfig, isFieldGroup } from "@/plugins/registry";

/**
 * The real seeding, not a copy of it. `generateAIActionPrompts` walks every
 * registered plugin, so the per-action body is exported separately - a test
 * that reimplemented the ladder could not fail when the ladder changed, which
 * is the only thing this file is for.
 */
function seededConfig(slug: string): Record<string, unknown> {
  const action = pagerDutyPlugin.actions.find((one) => one.slug === slug);
  if (!action) {
    throw new Error(`no action ${slug}`);
  }
  return buildExampleConfig(`pagerduty/${slug}`, action.configFields);
}

/**
 * The AI-seeded node, seen by the two things that read a config back.
 *
 * These two rules were written for different reasons and have to agree. The
 * collapsed-group badge treats a value equal to a field's `example` as "not
 * chosen", because that is what a generated node carries; the seeding rules
 * decide what that example is. Change one without the other and either every
 * generated node badges groups nobody touched, or a group holding a real
 * setting stays silent.
 */
describe("what an AI-generated PagerDuty node looks like to the editor", () => {
  const groups = pagerDutyPlugin.actions.flatMap((action) =>
    (action.configFields ?? [])
      .filter((field) => isFieldGroup(field))
      .map(
        (field) =>
          [
            `${action.slug} / ${field.label}`,
            field.fields,
            action.slug,
          ] as const
      )
  );

  it("has groups to check", () => {
    expect(groups.length).toBeGreaterThan(5);
  });

  it.each(groups.map(([name]) => name))(
    "badges nothing on a generated node: %s",
    (name) => {
      const entry = groups.find(([groupName]) => groupName === name);
      if (!entry) {
        throw new Error(`group ${name} disappeared`);
      }
      expect(summariseGroup(entry[1], seededConfig(entry[2]))).toEqual({
        count: 0,
        labels: [],
      });
    }
  );

  /**
   * Prose belongs only where the model has to write something. Everywhere
   * else it ships as a real value: `component: "Your component"` reaches
   * PagerDuty and shows on the incident, and the id-shaped fields were worse
   * still - see the dedup keys in pagerduty-generated-config.test.ts.
   */
  it("seeds prose only into fields the model must fill in", () => {
    const prose: string[] = [];
    for (const action of pagerDutyPlugin.actions) {
      for (const [key, value] of Object.entries(seededConfig(action.slug))) {
        if (typeof value === "string" && value.startsWith("Your ")) {
          prose.push(`${action.slug}.${key}`);
        }
      }
    }
    expect(prose.sort()).toEqual([
      "acknowledge-incident.pagerdutyServiceId",
      "create-incident.details",
      "create-incident.pagerdutyServiceId",
      "create-incident.title",
      "resolve-incident.pagerdutyServiceId",
      "send-change-event.pagerdutyServiceId",
      "send-change-event.source",
      "send-change-event.summary",
      "trigger-incident.pagerdutyServiceId",
      "trigger-incident.source",
    ]);
  });
});
