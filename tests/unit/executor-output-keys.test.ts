import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  evaluateConditionExpression,
  processCodeTemplates,
  processTemplates,
  resolveArraySource,
  resolveTemplateToRawValueChecked,
} from "@/lib/workflow/executor/executor.workflow";

type NodeOutputs = Record<string, { label: string; data: unknown }>;

// The run stores "node-1.a" under "node_1_a"; every read path finds it there.
const OUTPUTS: NodeOutputs = {
  node_1_a: { label: "HTTP", data: { status: 200, items: [1, 2] } },
};

describe("executor reads a node's output by sanitizeNodeId", () => {
  it("resolves a config template", () => {
    expect(
      processTemplates({ url: "{{@node-1.a:HTTP.status}}" }, OUTPUTS).url
    ).toBe("200");
  });

  it("resolves a raw value", () => {
    expect(
      resolveTemplateToRawValueChecked("node-1.a", "HTTP.status", OUTPUTS)
    ).toEqual({ found: true, value: 200 });
  });

  it("resolves a code template", () => {
    expect(
      processCodeTemplates("return {{@node-1.a:HTTP.status}};", OUTPUTS)
    ).toContain("200");
  });

  it("resolves a For Each array source", () => {
    expect(resolveArraySource("{{@node-1.a:HTTP.items}}", OUTPUTS)).toEqual([
      1, 2,
    ]);
  });

  it("resolves a condition", () => {
    expect(
      evaluateConditionExpression(
        "{{@node-1.a:HTTP.status}} === 200",
        OUTPUTS,
        new Map(),
        {}
      )
    ).toMatchObject({ result: true });
  });
});
