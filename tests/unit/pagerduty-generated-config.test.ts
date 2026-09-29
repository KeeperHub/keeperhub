import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import pagerDutyPlugin from "@/plugins/pagerduty";
import { buildExampleConfig } from "@/plugins/registry";

/**
 * What an AI-generated PagerDuty node is seeded with.
 *
 * `generateAIActionPrompts` builds one example config per action and puts it
 * in the workflow-generation system prompt, preferring `example`, then
 * `defaultValue`, then a type default. That makes `example` a behavioural
 * setting for every generated node, not documentation - so a field whose
 * example differs from its real default silently changes what those nodes do.
 *
 * This calls the real builder. Mirroring it here instead meant a change to
 * the seeding rules could not fail these tests.
 */
function seededConfig(slug: string): Record<string, unknown> {
  const action = pagerDutyPlugin.actions.find((one) => one.slug === slug);
  if (!action) {
    throw new Error(`no action ${slug}`);
  }
  return buildExampleConfig(`pagerduty/${slug}`, action.configFields);
}

describe("what an AI-generated PagerDuty node carries", () => {
  /**
   * The field that decides whether the node pages at all on the first
   * failure. An `example` of 2 here had every generated node sit out the
   * first failure - on an hourly check, an hour of silence nobody asked for.
   * Blank resolves to 1, which is "page now"; dropping it entirely would be
   * worse, since a number field with neither example nor default seeds 10.
   */
  it("does not seed a consecutive-runs threshold", () => {
    expect(seededConfig("trigger-incident").consecutiveRuns).toBe("");
  });

  /** Same shape: the documented default is 0, so an example of 2 is a change. */
  it.each(["resolve-incident", "acknowledge-incident"])(
    "does not seed a send delay on %s",
    (slug) => {
      expect(seededConfig(slug).sendDelaySeconds).toBe("");
    }
  );

  /**
   * A `fail-on-error-switch` with no declared default fell through to the
   * string branch and seeded the field's own label as its value. It happened
   * to be truthy, so it behaved correctly by accident; web3 declares "true".
   */
  it.each([
    "trigger-incident",
    "resolve-incident",
    "acknowledge-incident",
    "send-change-event",
    "create-incident",
  ])("seeds failOnError as a boolean string on %s", (slug) => {
    expect(seededConfig(slug).failOnError).toBe("true");
  });

  /**
   * The preview panel and the test button render; they collect nothing. Left
   * in, the prompt told the model to emit `"pagerdutyPreview":"Your preview"`
   * in every generated node, and the MCP pin schema offered them as settable
   * properties under `additionalProperties: false`.
   */
  it("carries no key for a field that only renders", () => {
    for (const action of pagerDutyPlugin.actions) {
      const config = seededConfig(action.slug);
      expect(Object.keys(config)).not.toContain("pagerdutyPreview");
      expect(Object.keys(config)).not.toContain("pagerdutyTestNode");
      expect(Object.keys(config)).not.toContain("pagerdutyFromEmailNotice");
    }
  });

  /**
   * Nothing that identifies something may be seeded with prose.
   *
   * A field with no `example` and no `defaultValue` falls through to
   * `Your <label>`, which for a free-text field is a harmless hint the model
   * replaces. For an id or a key it is a value that looks filled in and is
   * wrong, and the dedup keys were the dangerous case: the trigger seeded
   * "Your dedup key" and the resolve "Your dedup key of the alert", so every
   * generated workflow's resolve addressed a key no alert carried. PagerDuty
   * answers 202 to that, the node reported `delivered`, and the incident
   * stayed open for as long as the workflow ran.
   */
  it.each([
    ["trigger-incident", "dedupKey"],
    ["resolve-incident", "dedupKey"],
    ["resolve-incident", "dedupKeyFromNodeId"],
    ["acknowledge-incident", "dedupKey"],
    ["acknowledge-incident", "dedupKeyFromNodeId"],
    ["trigger-incident", "backupIntegrationId"],
    ["create-incident", "incidentKey"],
    ["create-incident", "fromEmail"],
    ["create-incident", "pagerdutyEscalationPolicyId"],
    ["create-incident", "pagerdutyPriorityId"],
  ])("seeds %s.%s blank rather than with prose", (slug, key) => {
    expect(seededConfig(slug)[key]).toBe("");
  });

  /** The two dedup keys have to agree, and blank is how they agree. */
  it("never seeds a resolve that addresses a different alert", () => {
    const trigger = seededConfig("trigger-incident");
    const resolve = seededConfig("resolve-incident");
    expect(resolve.dedupKey).toBe(trigger.dedupKey);
  });

  /**
   * Every value the model is handed has to be one the step would accept. A
   * seeded value that the runtime rejects is a generated workflow that fails
   * on its first run.
   */
  it("seeds nothing that its own field would reject", () => {
    const trigger = seededConfig("trigger-incident");
    expect(["critical", "error", "warning", "info"]).toContain(
      trigger.severity
    );
    expect(["true", "false"]).toContain(trigger.treatMaintenanceAsUndelivered);
    expect(["true", "false"]).toContain(
      seededConfig("resolve-incident").verifyWithPagerDuty
    );
    expect(["service-default", "high", "low"]).toContain(
      seededConfig("create-incident").urgency
    );
  });
});
