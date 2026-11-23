import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  hasTemplateVariables,
  processTemplate,
  remapTemplateRefsInString,
} from "@/lib/utils/template";
import { findActiveAtIndex } from "@/lib/workflow/editor/template-helpers";
import {
  extractTemplateParameters,
  processCodeTemplates,
  renderTemplateString,
} from "@/lib/workflow/executor/executor.workflow";
import {
  createTracker,
  scanForLeftoverLiterals,
  type UnresolvedRef,
} from "@/lib/workflow/executor/template-resolution";
import { findTemplateTokens } from "@/lib/workflow/template-ref";
import { validateWorkflowActionConfigs } from "@/lib/workflow/validation/action-config";

// Sized so the old quadratic patterns took tens of seconds, which leaves a
// wide margin for a slow runner under the bound below.
const BRACE_FLOOD = "{".repeat(200_000);
const REF_FLOOD = "{{@".repeat(70_000);
const TEMPLATE_FLOOD = "{{@a}}".repeat(100_000);
const TIME_LIMIT_MS = 1000;

const OUTPUTS = {
  n1: { label: "Parse {json", data: { address: "0xabc" } },
};

function timed<T>(run: () => T): { result: T; elapsedMs: number } {
  const start = performance.now();
  const result = run();
  return { result, elapsedMs: performance.now() - start };
}

function supplyNode(config: Record<string, string>): {
  id: string;
  type: string;
  data: { label: string; type: string; config: Record<string, string> };
} {
  return {
    id: "node-1",
    type: "action",
    data: {
      label: "Supply",
      type: "action",
      config: {
        actionType: "aave-v3/supply",
        network: "1",
        amount: "{{@node-0:Previous.amount}}",
        onBehalfOf: "{{@node-0:Previous.recipient}}",
        ...config,
      },
    },
  };
}

describe("template scanning on adversarial input", () => {
  it.each([
    ["brace flood", BRACE_FLOOD],
    ["reference flood", REF_FLOOD],
  ])("detection and resolution stay fast on a %s", (_name, input) => {
    const { elapsedMs } = timed(() => {
      hasTemplateVariables(input);
      processTemplate(input, OUTPUTS);
      remapTemplateRefsInString(input, new Map());
      scanForLeftoverLiterals(input, []);
      renderTemplateString(input, OUTPUTS, createTracker());
      processCodeTemplates(input, OUTPUTS, createTracker());
      extractTemplateParameters(input, OUTPUTS, createTracker());
    });
    expect(elapsedMs).toBeLessThan(TIME_LIMIT_MS);
  });

  it("findActiveAtIndex stays fast on a brace flood and on many templates", () => {
    const flood = timed(() => findActiveAtIndex(`${BRACE_FLOOD}@`));
    expect(flood.result).toBe(BRACE_FLOOD.length);
    expect(flood.elapsedMs).toBeLessThan(TIME_LIMIT_MS);

    const templates = timed(() => findActiveAtIndex(TEMPLATE_FLOOD));
    expect(templates.result).toBe(-1);
    expect(templates.elapsedMs).toBeLessThan(TIME_LIMIT_MS);
  });

  it("action config validation stays fast and rejects the flood as an address", () => {
    const { result, elapsedMs } = timed(() =>
      validateWorkflowActionConfigs([supplyNode({ asset: BRACE_FLOOD })])
    );
    expect(elapsedMs).toBeLessThan(TIME_LIMIT_MS);
    expect(result.issues.map((issue) => issue.field)).toEqual(["asset"]);
  });
});

describe("template detection agrees with the resolver", () => {
  const LABEL_WITH_BRACE_REF = "{{@n1:Parse {json.address}}";

  it("treats a reference whose label contains `{` as a template", () => {
    expect(hasTemplateVariables(LABEL_WITH_BRACE_REF)).toBe(true);
    expect(processTemplate(LABEL_WITH_BRACE_REF, OUTPUTS)).toBe("0xabc");
  });

  it("accepts that reference in an address field", () => {
    const { issues } = validateWorkflowActionConfigs([
      supplyNode({ asset: LABEL_WITH_BRACE_REF }),
    ]);
    expect(issues).toEqual([]);
  });

  it.each([
    "to {{@n1:Fetch.address}}",
    "{{{@n1:Fetch.address}}",
    "{{trigger.amount}}",
    "{{a{b}}",
    "{{}}",
    "{{a}b}}",
    "{{ }}",
  ])("hasTemplateVariables matches the leftover scan for %s", (value) => {
    const leftovers: UnresolvedRef[] = [];
    scanForLeftoverLiterals(value, leftovers);
    expect(hasTemplateVariables(value)).toBe(leftovers.length > 0);
  });

  it("findActiveAtIndex treats an `@` inside a token the badges render as taken", () => {
    const value = "{{{@n1:X.y}}";
    const [token] = findTemplateTokens(value);
    expect(token).toMatchObject({ start: 0, end: value.length });
    expect(findActiveAtIndex(value)).toBe(-1);
    expect(findActiveAtIndex(`${value} @`)).toBe(value.length + 1);
  });
});
