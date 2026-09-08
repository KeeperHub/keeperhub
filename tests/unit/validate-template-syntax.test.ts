/**
 * KEEP-468: PATCH-time template syntax validator.
 *
 * Verifies the three-grammar parser accepts the supported shapes and
 * rejects the typo classes the hackathon teams produced (empty token,
 * missing colon in stored format, empty `$`-only body). Display-format
 * tokens with arbitrary labels are accepted at the syntax layer; the
 * runtime fail-closed path catches unresolved references separately.
 */

import { describe, expect, it } from "vitest";

import {
  findInvalidTemplateTokens,
  validateTemplateBody,
} from "@/lib/workflow/validation/template-syntax";

describe("validateTemplateBody (single-token grammar)", () => {
  it("accepts the three supported grammars", () => {
    expect(validateTemplateBody("@node_1:HTTP Request.data.user")).toBeNull();
    expect(validateTemplateBody("@n1:Step")).toBeNull();
    expect(validateTemplateBody("$trigger.input.ts")).toBeNull();
    expect(validateTemplateBody("Trigger.timestamp")).toBeNull();
    expect(validateTemplateBody("HTTP Request")).toBeNull();
  });

  it("rejects empty / whitespace-only tokens", () => {
    expect(validateTemplateBody("")?.reason).toBe("empty");
    expect(validateTemplateBody("   ")?.reason).toBe("empty");
  });

  it("rejects stored-format references missing the colon separator", () => {
    expect(validateTemplateBody("@nodeId")?.reason).toBe("malformed-stored");
    expect(validateTemplateBody("@trigger.input.ts")?.reason).toBe(
      "malformed-stored"
    );
  });

  it("rejects stored-format references with empty halves", () => {
    expect(validateTemplateBody("@:Label")?.reason).toBe("malformed-stored");
    expect(validateTemplateBody("@nodeId:")?.reason).toBe("malformed-stored");
    expect(validateTemplateBody("@:")?.reason).toBe("malformed-stored");
  });

  it("rejects bare `$` without a body", () => {
    expect(validateTemplateBody("$")?.reason).toBe("malformed-dollar");
    expect(validateTemplateBody("$ ")?.reason).toBe("malformed-dollar");
  });
});

describe("findInvalidTemplateTokens (workflow walker)", () => {
  it("returns empty for a workflow with only valid templates", () => {
    const nodes = [
      {
        id: "n1",
        data: {
          config: {
            url: "https://api/{{@trigger:Trigger.input.ts}}",
            body: "{{Trigger.timestamp}}",
          },
        },
      },
    ];
    expect(findInvalidTemplateTokens(nodes)).toEqual([]);
  });

  it("flags the n8n-style typo class with the offending node id", () => {
    const nodes = [
      {
        id: "ens-write-1",
        data: {
          config: {
            // The original Tradewise corruption: missing `:` separator on
            // an otherwise stored-format reference.
            value: "{{@trigger.input.ts}}",
          },
        },
      },
    ];
    const findings = findInvalidTemplateTokens(nodes);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.reason).toBe("malformed-stored");
    expect(findings[0]?.nodeId).toBe("ens-write-1");
    expect(findings[0]?.token).toBe("{{@trigger.input.ts}}");
  });

  it("recurses into nested config values and arrays", () => {
    const nodes = [
      {
        id: "n1",
        data: {
          config: {
            outer: {
              list: ["ok", "{{@badNode}}"],
            },
          },
        },
      },
    ];
    const findings = findInvalidTemplateTokens(nodes);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.reason).toBe("malformed-stored");
  });

  it("ignores nodes with no config", () => {
    const nodes = [
      { id: "trigger", data: {} },
      { id: "noop", data: { config: undefined } },
    ];
    expect(findInvalidTemplateTokens(nodes)).toEqual([]);
  });

  it("returns empty when input is not an array", () => {
    expect(findInvalidTemplateTokens(null)).toEqual([]);
    expect(findInvalidTemplateTokens({})).toEqual([]);
    expect(findInvalidTemplateTokens("not an array")).toEqual([]);
  });

  it("collects multiple findings up to the cap", () => {
    const config: Record<string, string> = {};
    for (let i = 0; i < 30; i++) {
      config[`field${i}`] = "{{@}}";
    }
    const nodes = [{ id: "spam", data: { config } }];
    const findings = findInvalidTemplateTokens(nodes);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.length).toBeLessThanOrEqual(25);
  });
});
