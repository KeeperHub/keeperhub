/**
 * KEEP-468 hotfix regression: the action-level post-scan in
 * `processActionConfig` must not see `condition` / `conditionConfig`
 * fields. Those fields own their template resolution path
 * (`evaluateConditionExpression`, which has its own leftover-token gate),
 * so their `{{...}}` tokens are intentionally left in place at the action
 * level. The original KEEP-468 commit re-attached them onto
 * `processedConfig` BEFORE calling `assertResolved`, which made every
 * Condition node downstream of a For Each / data-producing step look like
 * it had a leftover literal and aborted the iteration.
 *
 * This test captures the contract directly against `assertResolved`:
 *   - A config that still contains a Condition's templated expression must
 *     NOT be scanned (it would false-trip the post-scan).
 *   - A config that omits the condition fields scans cleanly, even when
 *     the surrounding action's own fields resolve correctly.
 *   - A genuinely unresolved action field still fails closed regardless of
 *     whether condition fields are present.
 *
 * Confirmed against the prod incident on workflow `befqn0fu66t7un1mqm8r2`,
 * where every iteration of `Each Item` aborted with "Reference left in
 * rendered config; resolver did not match" pointing at the Condition
 * node's `{{@fe:Each Item.currentItem}} > 5` expression — even though
 * that token IS resolved by `evaluateConditionExpression` at evaluation
 * time.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  assertResolved,
  createTracker,
  TemplateResolutionError,
} from "@/lib/workflow/executor/template-resolution";

describe("KEEP-468 hotfix: action-level scan must not see condition fields", () => {
  it("regression baseline: scanning a config that still has a templated condition trips the post-scan", () => {
    const tracker = createTracker();
    const renderedConfig = {
      url: "https://example.com/static",
      condition: "{{@n1:Trigger.value}} > 5",
    };

    expect(() =>
      assertResolved(tracker, renderedConfig, {
        actionType: "Condition",
        nodeId: "cond_outer",
        nodeLabel: "Item gt 5",
      })
    ).toThrow(TemplateResolutionError);
  });

  it("scanning the same config WITHOUT the condition field is clean (post-fix order)", () => {
    const tracker = createTracker();
    const renderedConfig = {
      url: "https://example.com/static",
      // condition deliberately omitted: action-level scan runs first,
      // condition is re-attached AFTER (see processActionConfig).
    };

    expect(() =>
      assertResolved(tracker, renderedConfig, {
        actionType: "Condition",
        nodeId: "cond_outer",
        nodeLabel: "Item gt 5",
      })
    ).not.toThrow();
  });

  it("scanning a config without condition still fails on a leftover in the action's own fields", () => {
    const tracker = createTracker();
    // url legitimately failed to resolve at the action level — the post-scan
    // must still catch this even though condition fields are excluded.
    const renderedConfig = {
      url: "https://example.com/{{@missing:Foo.bar}}",
    };

    expect(() =>
      assertResolved(tracker, renderedConfig, {
        actionType: "HTTP Request",
        nodeId: "http_1",
        nodeLabel: "Fetch",
      })
    ).toThrow(TemplateResolutionError);
  });

  it("scanning a config without condition still passes on cleanly resolved fields", () => {
    const tracker = createTracker();
    const renderedConfig = {
      url: "https://example.com/api",
      method: "GET",
      headers: { Authorization: "Bearer secret-token" },
    };

    expect(() =>
      assertResolved(tracker, renderedConfig, {
        actionType: "HTTP Request",
        nodeId: "http_1",
        nodeLabel: "Fetch",
      })
    ).not.toThrow();
  });

  it("conditionConfig field carries the same risk and must also be excluded from the scan", () => {
    const tracker = createTracker();
    const renderedConfig = {
      url: "https://example.com/static",
      conditionConfig: {
        group: {
          combinator: "and",
          rules: [{ left: "{{@n1:Trigger.value}}", op: ">", right: 5 }],
        },
      },
    };

    // If conditionConfig is in the scanned config, the post-scan walks the
    // nested rules and trips on the inner template token. The hotfix
    // ensures conditionConfig is re-attached AFTER assertResolved.
    expect(() =>
      assertResolved(tracker, renderedConfig, {
        actionType: "Condition",
        nodeId: "cond_outer",
        nodeLabel: "Item gt 5",
      })
    ).toThrow(TemplateResolutionError);
  });
});
