import { describe, expect, it } from "vitest";
import {
  DEPRECATION_NOTICE_DAYS,
  sunsetFor,
  toStructuredFieldDate,
} from "@/lib/api-versioning";
import { docsUrl } from "@/lib/site/identity";
import {
  resolveExecutionInput,
  TOP_LEVEL_INPUT_DEPRECATION,
  topLevelInputDeprecationHeaders,
} from "@/lib/workflow/resolve-execution-input";

describe("resolveExecutionInput", () => {
  it("uses the nested input object when input is sent (unchanged shape)", () => {
    const result = resolveExecutionInput(
      JSON.stringify({ input: { amount: "1" } })
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.input).toEqual({ amount: "1" });
      expect(result.deprecated).toBeFalsy();
    }
  });

  it("binds a bare top-level field as input, with a deprecation warning (kh CLI compat)", () => {
    const result = resolveExecutionInput(JSON.stringify({ amount: "1" }));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.input).toEqual({ amount: "1" });
      expect(result.deprecated).toBe(true);
    }
  });

  it("binds multiple bare top-level fields as input, with a deprecation warning", () => {
    const result = resolveExecutionInput(
      JSON.stringify({ amount: "1", token: "USDC" })
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.input).toEqual({ amount: "1", token: "USDC" });
      expect(result.deprecated).toBe(true);
    }
  });

  it("rejects a body mixing a nested input object with stray top-level fields", () => {
    const result = resolveExecutionInput(
      JSON.stringify({ input: { amount: "1" }, amount: "2" })
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.field).toBe("input");
    }
  });

  it("accepts executionId alongside input without treating it as unrecognized", () => {
    const result = resolveExecutionInput(
      JSON.stringify({ input: { amount: "1" }, executionId: "exec_123" })
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.input).toEqual({ amount: "1" });
      expect(result.deprecated).toBeFalsy();
    }
  });

  it("accepts executionId alone with no input, no warning", () => {
    const result = resolveExecutionInput(
      JSON.stringify({ executionId: "exec_123" })
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.input).toEqual({});
      expect(result.deprecated).toBeFalsy();
    }
  });

  it("treats a null input the same as input being absent (matches staging's `?? {}` today)", () => {
    const result = resolveExecutionInput(JSON.stringify({ input: null }));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.input).toEqual({});
      expect(result.deprecated).toBeFalsy();
    }
  });

  it("treats null input plus a bare top-level field as the bare-field case, with a warning", () => {
    const result = resolveExecutionInput(
      JSON.stringify({ input: null, amount: "1" })
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.input).toEqual({ amount: "1" });
      expect(result.deprecated).toBe(true);
    }
  });

  it("rejects a non-null, non-object input value rather than silently coercing it", () => {
    const result = resolveExecutionInput(JSON.stringify({ input: "oops" }));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.field).toBe("input");
    }
  });

  it("rejects a non-object input even when no other top-level fields are present", () => {
    const result = resolveExecutionInput(JSON.stringify({ input: [1, 2] }));

    expect(result.ok).toBe(false);
  });

  it("defaults to empty input when neither input nor top-level fields are present", () => {
    const result = resolveExecutionInput(JSON.stringify({}));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.input).toEqual({});
      expect(result.deprecated).toBeFalsy();
    }
  });

  it("defaults to empty input for an empty raw body", () => {
    const result = resolveExecutionInput("");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.input).toEqual({});
    }
  });

  it("defaults to empty input for invalid JSON, matching the pre-fix contract", () => {
    const result = resolveExecutionInput("{not valid json");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.input).toEqual({});
    }
  });

  it("defaults to empty input when the JSON body is not an object (array)", () => {
    const result = resolveExecutionInput(JSON.stringify([1, 2, 3]));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.input).toEqual({});
    }
  });

  it("defaults to empty input when the JSON body is a bare null", () => {
    const result = resolveExecutionInput("null");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.input).toEqual({});
    }
  });

  it("defaults to empty input when the JSON body is a bare primitive", () => {
    const result = resolveExecutionInput('"just a string"');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.input).toEqual({});
    }
  });

  it("preserves the raw parsed body for callers that need it unmodified (idempotency hashing)", () => {
    const result = resolveExecutionInput(
      JSON.stringify({ input: { amount: "1" }, executionId: "exec_123" })
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.rawParsed).toEqual({
        input: { amount: "1" },
        executionId: "exec_123",
      });
    }
  });
  describe("executionId is an envelope field only in the nested shape", () => {
    it("exposes executionId as an envelope field when the body is nested", () => {
      const result = resolveExecutionInput(
        JSON.stringify({ input: { amount: "1" }, executionId: "exec_123" })
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.executionId).toBe("exec_123");
        expect(result.input).toEqual({ amount: "1" });
      }
    });

    it("binds executionId as caller input in the bare shape, and exposes no envelope id", () => {
      // The route addresses a workflow_executions row with the envelope id, so
      // a bare body's data field of the same name must never reach it.
      const result = resolveExecutionInput(
        JSON.stringify({ executionId: "run-42", amount: "1" })
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.executionId).toBeUndefined();
        expect(result.input).toEqual({ executionId: "run-42", amount: "1" });
        expect(result.deprecated).toBe(true);
      }
    });

    it("ignores a non-string executionId rather than passing it through", () => {
      const result = resolveExecutionInput(
        JSON.stringify({ input: {}, executionId: 42 })
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.executionId).toBeUndefined();
      }
    });
  });

  describe("prototype pollution", () => {
    it("keeps a __proto__ key as an own property of the bound input", () => {
      const result = resolveExecutionInput(
        '{"__proto__":{"isAdmin":true},"amount":"1"}'
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        // Assignment would have hit Object.prototype's setter, leaving an
        // input whose own keys are empty while a read by name still resolved.
        expect(Object.keys(result.input)).toContain("amount");
        expect(
          (result.input as Record<string, unknown>).isAdmin
        ).toBeUndefined();
      }
      expect(({} as Record<string, unknown>).isAdmin).toBeUndefined();
    });

    it("does not pollute Object.prototype through a nested input either", () => {
      const result = resolveExecutionInput(
        '{"input":{"__proto__":{"polluted":true}}}'
      );

      expect(result.ok).toBe(true);
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    });
  });

  describe("deprecation notice", () => {
    const headerValue = (name: string): string | undefined =>
      topLevelInputDeprecationHeaders().find(([key]) => key === name)?.[1];

    // Against the published constant, not a literal: the point of the
    // assertion is that this notice honours whatever minimum the API
    // currently guarantees, so lowering DEPRECATION_NOTICE_DAYS without
    // moving the sunset has to fail here.
    it("gives at least the published minimum notice between effective and sunset", () => {
      const effective = new Date(
        `${TOP_LEVEL_INPUT_DEPRECATION.effective}T00:00:00Z`
      ).getTime();
      const sunset = sunsetFor(TOP_LEVEL_INPUT_DEPRECATION.effective).getTime();
      const days = (sunset - effective) / 86_400_000;

      expect(days).toBeGreaterThanOrEqual(DEPRECATION_NOTICE_DAYS);
    });

    // RFC 9745 gives Deprecation a Structured Fields Date -- "@" plus integer
    // epoch seconds. An HTTP-date here is not a lenient variant: a conforming
    // parser rejects the field and treats it as absent, which is the silent
    // drop this header exists to prevent.
    it("sends Deprecation as a Structured Fields Date, not an HTTP-date", () => {
      const deprecation = headerValue("Deprecation");

      expect(deprecation).toBe(
        toStructuredFieldDate(TOP_LEVEL_INPUT_DEPRECATION.effective)
      );
      expect(deprecation).toMatch(/^@\d+$/);
    });

    // RFC 8594 gives Sunset an HTTP-date. The two headers genuinely disagree
    // on format; asserting both keeps a well-meaning "consistency" fix from
    // breaking one of them.
    it("sends Sunset as an HTTP-date derived from the effective date", () => {
      expect(headerValue("Sunset")).toBe(
        sunsetFor(TOP_LEVEL_INPUT_DEPRECATION.effective).toUTCString()
      );
    });

    it("emits the published header names rather than a bespoke one", () => {
      const names = topLevelInputDeprecationHeaders().map(([name]) => name);

      expect(names).toEqual(["Deprecation", "Sunset", "Link"]);
    });

    it('points Link at the migration note with rel="deprecation"', () => {
      const link = headerValue("Link");

      expect(link).toBe(
        `<${docsUrl()}${TOP_LEVEL_INPUT_DEPRECATION.linkPath}>; rel="deprecation"`
      );
    });

    // Resolved through docsUrl() at emit time rather than hardcoded, so a
    // self-hosted deployment points its own callers at its own docs instead
    // of ours.
    it("resolves the Link against this deployment's docs origin", () => {
      const original = process.env.DOCS_BASE_URL;
      process.env.DOCS_BASE_URL = "https://docs.self-hosted.example";
      try {
        expect(headerValue("Link")).toBe(
          `<https://docs.self-hosted.example${TOP_LEVEL_INPUT_DEPRECATION.linkPath}>; rel="deprecation"`
        );
      } finally {
        if (original === undefined) {
          delete process.env.DOCS_BASE_URL;
        } else {
          process.env.DOCS_BASE_URL = original;
        }
      }
    });
  });
});
