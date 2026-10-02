/**
 * A node's output is data, not a template. A `{{...}}` that arrives inside a
 * resolved value must not be read as a reference the author wrote.
 *
 * The shape that surfaced it: a For Each whose `arraySource` points at this
 * workflow's own execution history. Execution logs carry each node's config,
 * so the payload holds a verbatim copy of the `arraySource` reference itself,
 * and the step aborted naming its own correct reference. Comparing the
 * rendered string against the authored one cannot separate the two; only the
 * renderer knows where its own text ends and a substituted value begins.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { processTemplates } from "@/lib/workflow/executor/executor.workflow";
import {
  assertResolved,
  createTracker,
} from "@/lib/workflow/executor/template-resolution";

const UNRESOLVED_REF_MESSAGE = /Unresolved template reference/;

const ARRAY_SOURCE = "{{@http:Last executions.data}}";

// An executions payload holding both an earlier run's error text and a copy
// of the For Each node's own config, which is what the logs endpoint returns.
const outputs = {
  http: {
    label: "Last executions",
    data: {
      data: [
        {
          id: "yrkgtwxvjw99dlh78q7hw",
          error:
            'Unresolved template reference(s): {{QueryEvents.events}} (Display reference "QueryEvents.events" did not resolve.)',
          config: { arraySource: ARRAY_SOURCE },
        },
      ],
    },
  },
};

const render = (config: Record<string, unknown>) => {
  const tracker = createTracker();
  const processed = processTemplates(config, outputs, tracker);
  return { tracker, processed };
};

const assert = (
  tracker: ReturnType<typeof createTracker>,
  processed: Record<string, unknown>
) => assertResolved(tracker, processed, {}, { rendererScanned: true });

describe("a token carried in by resolved data is not a reference", () => {
  it("ignores a foreign token in the payload", () => {
    const { tracker, processed } = render({ arraySource: ARRAY_SOURCE });

    expect(String(processed.arraySource)).toContain("{{QueryEvents.events}}");
    expect(tracker.unresolved).toEqual([]);
    expect(() => assert(tracker, processed)).not.toThrow();
  });

  it("ignores a copy of the field's own reference in the payload", () => {
    const { tracker, processed } = render({ arraySource: ARRAY_SOURCE });

    // The payload quotes the arraySource reference verbatim, so a text
    // comparison against the authored value reports it as authored.
    expect(String(processed.arraySource)).toContain(ARRAY_SOURCE);
    expect(tracker.unresolved).toEqual([]);
    expect(() => assert(tracker, processed)).not.toThrow();
  });

  it("ignores data-borne tokens inside an array element", () => {
    const { tracker, processed } = render({ args: [ARRAY_SOURCE] });

    expect(tracker.unresolved).toEqual([]);
    expect(() => assert(tracker, processed)).not.toThrow();
  });

  it("ignores data-borne tokens nested in an object", () => {
    const { tracker, processed } = render({ meta: { to: ARRAY_SOURCE } });

    expect(tracker.unresolved).toEqual([]);
    expect(() => assert(tracker, processed)).not.toThrow();
  });
});

describe("a token the author wrote still fails the step", () => {
  it("records an unresolvable display reference", () => {
    const { tracker, processed } = render({ label: "{{Missing.node}}" });

    expect(tracker.unresolved[0]?.reason).toBe("no-path");
    expect(() => assert(tracker, processed)).toThrow(UNRESOLVED_REF_MESSAGE);
  });

  it("records a token neither reference form can match", () => {
    const { tracker, processed } = render({ arraySource: "{{@noColonHere}}" });

    expect(tracker.unresolved[0]?.reason).toBe("literal-leftover");
    expect(() => assert(tracker, processed)).toThrow(UNRESOLVED_REF_MESSAGE);
  });

  it("names the field that held an unmatchable token", () => {
    const { tracker } = render({ arraySource: "{{@noColonHere}}" });

    expect(tracker.unresolved[0]?.path).toBe("arraySource");
  });

  it("names a nested field by its path", () => {
    const { tracker } = render({ calls: [{ to: "{{@noColonHere}}" }] });

    expect(tracker.unresolved[0]?.path).toBe("calls[0].to");
  });

  it("catches an unmatchable token beside a reference that resolved", () => {
    const { tracker, processed } = render({
      arraySource: `${ARRAY_SOURCE} {{@noColonHere}}`,
    });

    expect(tracker.unresolved).toHaveLength(1);
    expect(tracker.unresolved[0]?.token).toBe("{{@noColonHere}}");
    expect(() => assert(tracker, processed)).toThrow(UNRESOLVED_REF_MESSAGE);
  });
});

describe("references resolve in a single pass", () => {
  it("does not resolve a display ref that came from a resolved value", () => {
    const tracker = createTracker();
    const processed = processTemplates(
      { message: "{{@src:Src.note}}" },
      {
        src: { label: "Src", data: { note: "see {{Other.field}}" } },
        Other: { label: "Other", data: { field: "SUBSTITUTED" } },
      },
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
