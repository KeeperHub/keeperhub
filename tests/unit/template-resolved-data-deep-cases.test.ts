/**
 * Deep cases for the boundary between the author's template text and the
 * values substituted into it.
 *
 * The production shape these come from: a For Each whose `arraySource` reads
 * this workflow's own execution history. Execution logs carry every node's
 * config, so the payload holds a verbatim copy of the `arraySource` reference
 * itself, next to the error text of earlier runs. Every case below keeps that
 * property and asks whether the gate still tells an authored reference from a
 * data-borne one.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  extractTemplateParameters,
  processCodeTemplates,
  processTemplates,
  resolveArraySource,
} from "@/lib/workflow/executor/executor.workflow";
import {
  assertResolved,
  createTracker,
} from "@/lib/workflow/executor/template-resolution";

const UNRESOLVED_REF_MESSAGE = /Unresolved template reference/;

const ARRAY_SOURCE = "{{@http:Last executions.data}}";
const FOREIGN = "{{QueryEvents.events}}";

/** One execution as the logs endpoint returns it: error text plus node config. */
const execution = (id: string) => ({
  id,
  status: "error",
  error: `Unresolved template reference(s): ${FOREIGN} at arraySource`,
  logs: [
    {
      nodeId: "Pr_Syw",
      status: "error",
      input: { arraySource: ARRAY_SOURCE, maxIterations: "4" },
    },
  ],
});

const outputs = {
  http: {
    label: "Last executions",
    data: { data: [execution("run_a"), execution("run_b")] },
  },
  src: { label: "Src", data: { a: "first", note: `see ${FOREIGN}` } },
  n1: { label: "Read Hat", data: { success: true, result: "0xhat" } },
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

describe("For Each over its own execution history, end to end", () => {
  it("resolves the array even though the payload quotes the reference", () => {
    const authored = { arraySource: ARRAY_SOURCE, maxIterations: "4" };
    const { tracker, processed } = render(authored);

    // The property that broke the previous fix.
    expect(String(processed.arraySource)).toContain(ARRAY_SOURCE);
    expect(String(processed.arraySource)).toContain(FOREIGN);

    expect(() => assert(tracker, processed)).not.toThrow();

    const items = resolveArraySource(processed.arraySource, outputs);
    expect(items).toHaveLength(2);
    expect((items[0] as { id: string }).id).toBe("run_a");
  });

  it("still fails when the array reference itself is wrong", () => {
    const { tracker, processed } = render({
      arraySource: "{{@http:Last executions.notAField}}",
    });

    expect(tracker.unresolved[0]?.reason).toBe("no-path");
    expect(() => assert(tracker, processed)).toThrow(UNRESOLVED_REF_MESSAGE);
  });
});

describe("the same token authored and data-borne", () => {
  it("fails on the authored copy even when the payload carries it too", () => {
    const { tracker, processed } = render({
      arraySource: ARRAY_SOURCE,
      label: FOREIGN,
    });

    expect(String(processed.arraySource)).toContain(FOREIGN);
    expect(tracker.unresolved).toHaveLength(1);
    expect(tracker.unresolved[0]?.path).toBe("label");
    expect(() => assert(tracker, processed)).toThrow(UNRESOLVED_REF_MESSAGE);
  });

  it("does not resolve a stored reference that came from the payload", () => {
    const { tracker, processed } = render({ note: "{{@src:Src.note}}" });

    expect(processed.note).toBe(`see ${FOREIGN}`);
    expect(tracker.unresolved).toEqual([]);
    expect(() => assert(tracker, processed)).not.toThrow();
  });
});

describe("tokens formed across the boundary", () => {
  it("ignores a token whose opening braces came from the payload", () => {
    const outputsWithOpenBrace = {
      src: { label: "Src", data: { a: "prefix {{" } },
    };
    const tracker = createTracker();
    const processed = processTemplates(
      { url: "{{@src:Src.a}}Other.field}}" },
      outputsWithOpenBrace,
      tracker
    );

    expect(processed.url).toBe("prefix {{Other.field}}");
    expect(tracker.unresolved).toEqual([]);
    expect(() => assert(tracker, processed)).not.toThrow();
  });

  it("ignores an unclosed brace pair the author left", () => {
    const { tracker, processed } = render({ url: "https://x/{{" });

    expect(tracker.unresolved).toEqual([]);
    expect(() => assert(tracker, processed)).not.toThrow();
  });
});

describe("depth and volume", () => {
  const nest = (depth: number, leaf: unknown): unknown =>
    depth === 0 ? leaf : [nest(depth - 1, leaf)];

  it("reports an authored token nested past the old scan's depth limit", () => {
    const { tracker, processed } = render({
      functionArgs: nest(14, "{{@noColonHere}}"),
    });

    expect(tracker.unresolved[0]?.reason).toBe("literal-leftover");
    expect(tracker.unresolved[0]?.path).toContain("functionArgs");
    expect(() => assert(tracker, processed)).toThrow(UNRESOLVED_REF_MESSAGE);
  });

  it("stays clean with a data-borne token nested that deep", () => {
    const { tracker, processed } = render({
      functionArgs: nest(14, ARRAY_SOURCE),
    });

    expect(tracker.unresolved).toEqual([]);
    expect(() => assert(tracker, processed)).not.toThrow();
  });

  it("does not fill the tracker from a payload holding many tokens", () => {
    const many = Array.from({ length: 200 }, (_, i) => `{{Token${i}.field}}`);
    const bulk = {
      http: { label: "Last executions", data: { data: many.join(" ") } },
    };
    const tracker = createTracker();
    const processed = processTemplates(
      { arraySource: ARRAY_SOURCE },
      bulk,
      tracker
    );

    expect(String(processed.arraySource)).toContain("{{Token199.field}}");
    expect(tracker.unresolved).toEqual([]);
    expect(() => assert(tracker, processed)).not.toThrow();
  });
});

describe("the other fields that read upstream data", () => {
  it("keeps a SQL parameter holding brace text out of the gate", () => {
    const tracker = createTracker();
    const { parameterizedQuery, paramValues } = extractTemplateParameters(
      "SELECT * FROM runs WHERE payload = {{@src:Src.note}}",
      outputs,
      tracker
    );

    expect(parameterizedQuery).toBe("SELECT * FROM runs WHERE payload = $1");
    expect(paramValues).toEqual([`see ${FOREIGN}`]);
    expect(tracker.unresolved).toEqual([]);

    // _dbParams rides on the config the executor asserts over.
    expect(() =>
      assert(tracker, { dbQuery: parameterizedQuery, _dbParams: paramValues })
    ).not.toThrow();
  });

  it("keeps brace text inlined into a code field out of the gate", () => {
    const tracker = createTracker();
    const rendered = processCodeTemplates(
      "const runs = {{@http:Last executions.data}};",
      outputs,
      tracker
    );

    expect(rendered).toContain(FOREIGN);
    expect(tracker.unresolved).toEqual([]);
  });

  it("still fails a code field on a reference the author got wrong", () => {
    const tracker = createTracker();
    processCodeTemplates(
      "const x = {{@http:Last executions.notAField}};",
      outputs,
      tracker
    );

    expect(tracker.unresolved[0]?.reason).toBe("no-path");
  });

  it("keeps an HTTP endpoint built from upstream data out of the gate", () => {
    const { tracker, processed } = render({
      endpoint: "https://api.example.com/logs?note={{@src:Src.note}}",
      headers: { "X-Note": "{{@src:Src.note}}" },
    });

    expect(String(processed.endpoint)).toContain(FOREIGN);
    expect(tracker.unresolved).toEqual([]);
    expect(() => assert(tracker, processed)).not.toThrow();
  });
});
