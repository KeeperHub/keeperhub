/**
 * A node's output is data, not a template. A `{{...}}` that arrives inside a
 * resolved value must not be read as a reference the author wrote.
 *
 * The shape that surfaced it: a For Each whose `arraySource` points at an
 * executions API response. Every failed run stores an error message that
 * quotes the tokens it could not resolve, the next run reads that message
 * back, and the step aborted on a reference that exists nowhere in the
 * workflow. Each abort wrote a fresh message, so the fault fed itself.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { processTemplates } from "@/lib/workflow/executor/executor.workflow";
import {
  assertResolved,
  createTracker,
  scanForLeftoverLiterals,
  type UnresolvedRef,
} from "@/lib/workflow/executor/template-resolution";

const UNRESOLVED_REF_MESSAGE = /Unresolved template reference/;

// An executions payload carrying the error text of an earlier failed run.
const outputs = {
  http: {
    label: "Get current workflow last executions",
    data: {
      data: [
        {
          id: "yrkgtwxvjw99dlh78q7hw",
          status: "error",
          error:
            'Unresolved template reference(s): {{QueryEvents.events}} (Display reference "QueryEvents.events" did not resolve.)',
        },
        { id: "4ykuhvwl2ipp49nlpyld0", status: "success", error: null },
      ],
    },
  },
};

const ARRAY_SOURCE = "{{@http:Get current workflow last executions.data}}";

const render = (config: Record<string, unknown>) => {
  const tracker = createTracker();
  const processed = processTemplates(config, outputs, tracker);
  return { tracker, processed };
};

describe("a token carried in by resolved data is not a reference", () => {
  it("does not record a token that only appears after rendering", () => {
    const { tracker, processed } = render({ arraySource: ARRAY_SOURCE });

    expect(String(processed.arraySource)).toContain("{{QueryEvents.events}}");
    expect(tracker.unresolved).toEqual([]);
  });

  it("does not fail the step for it", () => {
    const { tracker, processed } = render({ arraySource: ARRAY_SOURCE });

    expect(() =>
      assertResolved(
        tracker,
        processed,
        { actionType: "For Each" },
        {
          config: { arraySource: ARRAY_SOURCE },
        }
      )
    ).not.toThrow();
  });

  it("still fails the step for a token the author wrote", () => {
    const authored = {
      arraySource: ARRAY_SOURCE,
      label: "{{Missing.node}}",
    };
    const { tracker, processed } = render(authored);

    expect(() =>
      assertResolved(
        tracker,
        processed,
        { actionType: "For Each" },
        {
          config: authored,
        }
      )
    ).toThrow(UNRESOLVED_REF_MESSAGE);
  });

  it("leaves data-borne tokens alone inside an array element", () => {
    const authored = { args: [ARRAY_SOURCE] };
    const { tracker, processed } = render(authored);

    expect(() =>
      assertResolved(tracker, processed, {}, { config: authored })
    ).not.toThrow();
  });

  it("reports an authored token nested in an object", () => {
    const authored = { meta: { to: "{{Missing.node}}" } };
    const { tracker, processed } = render(authored);

    expect(() =>
      assertResolved(tracker, processed, {}, { config: authored })
    ).toThrow(UNRESOLVED_REF_MESSAGE);
  });

  it("names the field holding an authored token", () => {
    const authored = { arraySource: "{{Missing.node}}" };
    const out: UnresolvedRef[] = [];
    const { processed } = render(authored);

    scanForLeftoverLiterals(processed, out, 0, "", { config: authored });

    expect(out).toHaveLength(1);
    expect(out[0]?.path).toBe("arraySource");
  });

  it("reports every leftover when no authored config is given", () => {
    const out: UnresolvedRef[] = [];
    const { processed } = render({ arraySource: ARRAY_SOURCE });

    scanForLeftoverLiterals(processed, out);

    expect(out.length).toBeGreaterThan(0);
  });
});

describe("references resolve in a single pass", () => {
  it("does not resolve a display ref that came from a resolved value", () => {
    const withToken = {
      src: { label: "Src", data: { note: "see {{Other.field}}" } },
      Other: { label: "Other", data: { field: "SUBSTITUTED" } },
    };
    const tracker = createTracker();
    const processed = processTemplates(
      { message: "{{@src:Src.note}}" },
      withToken,
      tracker
    );

    expect(processed.message).toBe("see {{Other.field}}");
    expect(tracker.unresolved).toEqual([]);
  });

  it("still resolves a display ref the author wrote", () => {
    const tracker = createTracker();
    const processed = processTemplates(
      { message: "{{Other.field}}" },
      { Other: { label: "Other", data: { field: "SUBSTITUTED" } } },
      tracker
    );

    expect(processed.message).toBe("SUBSTITUTED");
    expect(tracker.unresolved).toEqual([]);
  });

  it("resolves both reference forms in one string", () => {
    const tracker = createTracker();
    const processed = processTemplates(
      { message: "{{@src:Src.a}} and {{Other.field}}" },
      {
        src: { label: "Src", data: { a: "first" } },
        Other: { label: "Other", data: { field: "second" } },
      },
      tracker
    );

    expect(processed.message).toBe("first and second");
    expect(tracker.unresolved).toEqual([]);
  });
});
