/**
 * KEEP-442: HTTP Request system action's `endpoint`, `httpHeaders`, and
 * `httpBody` string fields go through the workflow template substitution
 * layer (`processTemplates`) like every other config string. The bug was
 * that templates resolved to "" when referencing a `code/run-code`
 * upstream because the resolver did not unwrap the run-code wrapper
 * shape `{ success, result, logs }` -- only the HTTP-style `{ data: ... }`
 * wrapper. Adding a `.result` fallback to `resolveFromOutputData` makes
 * `{{@runCodeNode:Label.fieldInsideResult}}` resolve correctly and is
 * what unblocks the dynamic Bridge Route Optimizer / MEV-Aware Swap
 * Quote workflows in the catalog roadmap.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  processTemplates,
  resolveFromOutputData,
} from "@/lib/workflow/executor/executor.workflow";

type NodeOutputs = Record<string, { label: string; data: unknown }>;

// Shape that runCodeStep returns when user code does `return { url, ... }`.
const RUN_CODE_OUTPUT = {
  success: true,
  result: {
    url: "https://app.across.to/api/suggested-fees?inputToken=0xA0b&outputToken=0x833&originChainId=1&destinationChainId=8453&amount=1000000",
    headers: { "X-Trace": "abc" },
    body: { hello: "world" },
  },
  logs: [],
};

const HTTP_STEP_OUTPUT = {
  success: true,
  data: {
    items: [{ name: "First" }, { name: "Second" }],
    nextCursor: "cur_42",
  },
  status: 200,
};

describe("KEEP-442: HTTP Request template substitution from run-code outputs", () => {
  describe("resolveFromOutputData", () => {
    it("resolves a top-level field directly", () => {
      const data = { url: "https://example.com" };
      expect(resolveFromOutputData(data, "url")).toBe("https://example.com");
    });

    it("unwraps the HTTP-style { data: ... } wrapper for downstream lookups", () => {
      expect(resolveFromOutputData(HTTP_STEP_OUTPUT, "items[0].name")).toBe(
        "First"
      );
      expect(resolveFromOutputData(HTTP_STEP_OUTPUT, "nextCursor")).toBe(
        "cur_42"
      );
    });

    it("unwraps the run-code-style { result: ... } wrapper -- the KEEP-442 fix", () => {
      expect(resolveFromOutputData(RUN_CODE_OUTPUT, "url")).toBe(
        RUN_CODE_OUTPUT.result.url
      );
      expect(resolveFromOutputData(RUN_CODE_OUTPUT, "headers.X-Trace")).toBe(
        "abc"
      );
      expect(resolveFromOutputData(RUN_CODE_OUTPUT, "body.hello")).toBe(
        "world"
      );
    });

    it("still honours an explicit `result.` prefix (back-compat)", () => {
      expect(resolveFromOutputData(RUN_CODE_OUTPUT, "result.url")).toBe(
        RUN_CODE_OUTPUT.result.url
      );
    });

    it("returns undefined when the field path is not found in any wrapper", () => {
      expect(resolveFromOutputData(RUN_CODE_OUTPUT, "missing.deep")).toBe(
        undefined
      );
    });

    it("prefers top-level over the .result fallback when both have the same key", () => {
      const data = { url: "TOP", result: { url: "INNER" } };
      expect(resolveFromOutputData(data, "url")).toBe("TOP");
    });

    it("prefers .data over .result when both wrappers exist", () => {
      const data = {
        success: true,
        data: { url: "FROM_DATA" },
        result: { url: "FROM_RESULT" },
      };
      expect(resolveFromOutputData(data, "url")).toBe("FROM_DATA");
    });

    // Documents the intentional fall-through behavior when both wrappers exist
    // but the path is missing inside .data: continue searching .result rather
    // than stopping. Useful for hypothetical step outputs that carry both
    // wrappers; safe today because no shipping step does.
    it("falls through from .data to .result when the path is absent inside .data", () => {
      const data = {
        success: true,
        data: { other: "x" },
        result: { url: "FROM_RESULT" },
      };
      expect(resolveFromOutputData(data, "url")).toBe("FROM_RESULT");
    });

    it("ignores .data when the wrapper value is null (still tries .result)", () => {
      const data = {
        success: true,
        data: null,
        result: { url: "FROM_RESULT" },
      };
      expect(resolveFromOutputData(data, "url")).toBe("FROM_RESULT");
    });

    it("ignores a null .result wrapper (does not throw)", () => {
      const data = { success: true, result: null };
      expect(resolveFromOutputData(data, "url")).toBe(undefined);
    });

    // Pre-existing behavior we are pinning, not changing: a primitive
    // result (e.g. `return "https://x"` from code/run-code) is rejected by
    // hasNestedResultShape because the fallback can only walk into objects.
    // The whole-output reference (no field path) returns the wrapper
    // because top-level lookup succeeds.
    it("does not unwrap a primitive .result; whole-output ref still works", () => {
      const data = { success: true, result: "https://primitive", logs: [] };
      expect(resolveFromOutputData(data, "anything")).toBe(undefined);
      expect(resolveFromOutputData(data, "")).toEqual(data);
    });
  });

  describe("processTemplates -- HTTP Request fields with run-code upstream", () => {
    const outputs: NodeOutputs = {
      prep: { label: "Prep", data: RUN_CODE_OUTPUT },
    };

    it("resolves {{@prep:Prep.url}} in the endpoint field (KEEP-442 repro)", () => {
      const config = {
        actionType: "HTTP Request",
        httpMethod: "GET",
        endpoint: "{{@prep:Prep.url}}",
        httpHeaders: "{}",
        httpBody: "{}",
      };
      const processed = processTemplates(config, outputs);
      expect(processed.endpoint).toBe(RUN_CODE_OUTPUT.result.url);
    });

    it("resolves templates embedded in httpHeaders and httpBody JSON strings", () => {
      const config = {
        actionType: "HTTP Request",
        httpMethod: "POST",
        endpoint: "https://api.example.com/x",
        httpHeaders: '{"X-Trace": "{{@prep:Prep.headers.X-Trace}}"}',
        httpBody: '{"greeting": "{{@prep:Prep.body.hello}}"}',
      };
      const processed = processTemplates(config, outputs);
      expect(processed.httpHeaders).toBe('{"X-Trace": "abc"}');
      expect(processed.httpBody).toBe('{"greeting": "world"}');
    });

    it("resolves templates referencing an HTTP upstream (existing flow stays intact)", () => {
      const httpOutputs: NodeOutputs = {
        api: { label: "API", data: HTTP_STEP_OUTPUT },
      };
      const config = {
        endpoint: "https://x.test/page?cursor={{@api:API.nextCursor}}",
      };
      const processed = processTemplates(config, httpOutputs);
      expect(processed.endpoint).toBe("https://x.test/page?cursor=cur_42");
    });

    it("falls back to '' when the referenced node is not in outputs", () => {
      const config = {
        endpoint: "{{@missing:Whatever.url}}",
      };
      const processed = processTemplates(config, outputs);
      expect(processed.endpoint).toBe("");
    });
  });
});
