// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConditionGroup } from "@/lib/workflow/nodes/condition/builder-types";

vi.mock("@/components/ui/template-badge-input", () => ({
  TemplateBadgeInput: ({
    value,
    onChange,
  }: {
    value: string;
    onChange: (value: string) => void;
  }) => (
    <input
      aria-label="expression"
      onChange={(event) => onChange(event.target.value)}
      value={value}
    />
  ),
}));
vi.mock("@/components/workflow/condition-query-builder", () => ({
  ConditionQueryBuilder: ({ group }: { group: ConditionGroup }) => (
    <div data-testid="builder">{group.rules.length}</div>
  ),
}));

import { ConditionFields } from "@/components/workflow/config/condition-fields";
import { visualConditionToExpression } from "@/lib/workflow/nodes/condition/builder-utils";

const FIELD = "{{@n1:Webhook.value}}";

// The builder writes exists next to another rule in a shape its own parser
// does not rebuild exactly, so only the saved rules can show it as rules.
const SAVED: ConditionGroup = {
  id: "g",
  logic: "AND",
  rules: [
    { id: "a", leftOperand: FIELD, operator: "===", rightOperand: "5" },
    { id: "b", leftOperand: FIELD, operator: "exists", rightOperand: "" },
  ],
};

type Config = Record<string, unknown>;
type Update = [string, unknown];

let container: HTMLDivElement;
let root: Root;
let updates: Update[];

function Harness({ initial }: { initial: Config }): React.ReactElement {
  const [config, setConfig] = useState<Config>(initial);
  return (
    <ConditionFields
      config={config}
      disabled={false}
      onUpdateConfig={(key, value) => {
        updates.push([key, value]);
        setConfig((current) => ({ ...current, [key]: value }));
      }}
    />
  );
}

function render(initial: Config): void {
  act(() => root.render(<Harness initial={initial} />));
}

function click(label: string): void {
  const button = [...container.querySelectorAll("button")].find(
    (b) => b.textContent === label
  );
  act(() => button?.click());
}

function type(value: string): void {
  const input = container.querySelector<HTMLInputElement>(
    'input[aria-label="expression"]'
  );
  if (!input) {
    throw new Error("not in Expression mode");
  }
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value"
  )?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  updates = [];
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("Condition fields", () => {
  it("keeps the saved rules across a switch to Expression and back", () => {
    render({
      actionType: "Condition",
      condition: visualConditionToExpression(SAVED),
      conditionConfig: { group: SAVED },
    });
    click("Expression");
    click("Visual");
    expect(
      container.querySelector('[data-testid="builder"]')?.textContent
    ).toBe("2");
    expect(updates).toEqual([]);
  });

  it("clears the saved rules when the text is edited, so the text runs", () => {
    render({
      actionType: "Condition",
      condition: visualConditionToExpression(SAVED),
      conditionConfig: { group: SAVED },
    });
    click("Expression");
    type(`${FIELD} === 6`);
    expect(updates).toEqual([
      ["conditionConfig", undefined],
      ["condition", `${FIELD} === 6`],
    ]);
  });

  // A half-typed text that parses must not be saved as the rules that run.
  it("saves no rules while typing in Expression mode", () => {
    render({ actionType: "Condition", condition: `${FIELD} >  1` });
    type(`${FIELD} === 1`);
    type(`${FIELD} === 10`);
    expect(updates.filter(([key]) => key === "conditionConfig")).toEqual([]);
    click("Visual");
    expect(updates.at(-1)?.[0]).toBe("conditionConfig");
  });

  it("says when the text can't be shown as rules", () => {
    render({ actionType: "Condition", condition: `${FIELD} === 1\n|| x` });
    click("Visual");
    expect(container.textContent).toContain(
      "This condition can't be shown as rules without changing it."
    );
    expect(container.textContent).toContain("Current expression");
  });
});
