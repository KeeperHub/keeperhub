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
// One rule the mocked builder writes when its button is pressed.
const EDITED: ConditionGroup = {
  id: "e",
  logic: "AND",
  rules: [
    {
      id: "r",
      leftOperand: "{{@n1:Webhook.value}}",
      operator: "===",
      rightOperand: "9",
    },
  ],
};

// A rule being filled in: a field picked, no value yet. It writes "true".
const PARTIAL: ConditionGroup = {
  id: "p",
  logic: "AND",
  rules: [
    {
      id: "r",
      leftOperand: "{{@n1:Webhook.value}}",
      operator: "===",
      rightOperand: "",
    },
  ],
};

vi.mock("@/components/workflow/condition-query-builder", () => ({
  ConditionQueryBuilder: ({
    group,
    onChange,
  }: {
    group: ConditionGroup;
    onChange: (group: ConditionGroup) => void;
  }) => (
    <div>
      <div data-group-id={group.id} data-testid="builder">
        {group.rules.length}
      </div>
      <div data-testid="first-left">
        {"leftOperand" in (group.rules[0] ?? {})
          ? (group.rules[0] as { leftOperand: string }).leftOperand
          : ""}
      </div>
      <button onClick={() => onChange(EDITED)} type="button">
        Edit rule
      </button>
      <button onClick={() => onChange(PARTIAL)} type="button">
        Pick a field
      </button>
    </div>
  ),
}));

import { getDefaultStore } from "jotai";
import { ConditionFields } from "@/components/workflow/config/action-config";
import { visualConditionToExpression } from "@/lib/workflow/nodes/condition/builder-utils";
import { REGEX_WORKFLOW_COMPILE_ERROR } from "@/lib/workflow/nodes/condition/regex-match";
import { nodesAtom, type WorkflowNode } from "@/lib/workflow/store";

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

function Harness({
  initial,
  disabled = false,
}: {
  initial: Config;
  disabled?: boolean;
}): React.ReactElement {
  const [config, setConfig] = useState<Config>(initial);
  return (
    <ConditionFields
      config={config}
      disabled={disabled}
      onUpdateConfig={(key, value) => {
        updates.push([key, value]);
        setConfig((current) => ({ ...current, [key]: value }));
      }}
    />
  );
}

function render(initial: Config, disabled = false): void {
  act(() => root.render(<Harness disabled={disabled} initial={initial} />));
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
  getDefaultStore().set(nodesAtom, []);
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
    expect(container.textContent).not.toContain("can't be shown as rules");
    expect(container.textContent).toContain("Generated expression");
    expect(updates).toEqual([]);
  });

  // An unfinished rule runs nothing, but must stay in the builder while it
  // is filled in.
  it("keeps a rule being filled in on a new node", () => {
    render({ actionType: "Condition" });
    click("Pick a field");
    expect(
      container.querySelector('[data-testid="first-left"]')?.textContent
    ).toBe(FIELD);
    expect(container.textContent).not.toContain("can't be shown as rules");
  });

  // Someone who can only view a workflow must not write to it by opening it.
  it("saves parsed rules on open only for someone who can edit", () => {
    render({ actionType: "Condition", condition: `${FIELD} === 1` }, true);
    expect(updates).toEqual([]);
    act(() => root.unmount());
    root = createRoot(container);
    render({ actionType: "Condition", condition: `${FIELD} === 1` });
    expect(updates.map(([key]) => key)).toEqual(["conditionConfig"]);
  });

  // Unfinished rules write "true", which runs nothing: a typed "true" is the
  // text, and those rules are never brought back by an edit.
  it("keeps a typed true as text beside unfinished rules", () => {
    render({ actionType: "Condition", conditionConfig: { group: PARTIAL } });
    click("Expression");
    type("true");
    expect(updates).toEqual([
      ["conditionConfig", undefined],
      ["condition", "true"],
    ]);
    type("truex");
    type("true");
    expect(updates.filter(([key]) => key === "conditionConfig")).toEqual([
      ["conditionConfig", undefined],
    ]);
  });

  // The region is on the page before the switch, so the notice is announced.
  it("announces the notice in a region that was already mounted", () => {
    render({ actionType: "Condition", condition: `${FIELD} === 1\n|| x` });
    const region = container.querySelector('[aria-live="polite"]');
    expect(region?.textContent).toBe("");
    click("Visual");
    expect(region?.isConnected).toBe(true);
    expect(region?.textContent).toContain("can't be shown as rules");
  });

  // The notice's warning: a rule edit replaces the text with the rules.
  it("writes the rules and their text when a rule is edited", () => {
    render({ actionType: "Condition", condition: `${FIELD} === 1\n|| x` });
    click("Visual");
    click("Edit rule");
    expect(updates).toEqual([
      ["conditionConfig", { group: EDITED }],
      ["condition", visualConditionToExpression(EDITED)],
    ]);
    expect(container.textContent).not.toContain("can't be shown as rules");
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
    const notice = [...container.querySelectorAll("p")].find((p) =>
      p.textContent?.startsWith("This expression")
    );
    expect(notice?.textContent?.replace(/\s+/g, " ")).toBe(
      "This expression can't be shown as rules. Any change below replaces it. To keep it, edit it in Expression mode."
    );
    // Announced: it appears in a region that was already on the page.
    expect(notice?.closest('[aria-live="polite"]')).not.toBeNull();
    expect(container.textContent).toContain("Current expression");
  });

  // A typed-then-deleted character leaves the text as the rules wrote it.
  it("brings the rules back when the text returns to what they write", () => {
    const text = visualConditionToExpression(SAVED);
    render({
      actionType: "Condition",
      condition: text,
      conditionConfig: { group: SAVED },
    });
    click("Expression");
    type(`${text} `);
    type(text);
    click("Visual");
    expect(
      container.querySelector('[data-testid="builder"]')?.textContent
    ).toBe("2");
    expect(updates.at(-2)).toEqual(["conditionConfig", { group: SAVED }]);
  });

  // Blank saved rules write "true"; the run uses the saved text instead.
  it("does not show blank saved rules as the rules of the text that runs", () => {
    render({
      actionType: "Condition",
      condition: `${FIELD} === 1\n|| x`,
      conditionConfig: {
        group: {
          id: "g",
          logic: "AND",
          rules: [
            { id: "r", leftOperand: "", operator: "===", rightOperand: "" },
          ],
        },
      },
    });
    click("Visual");
    expect(container.textContent).toContain(
      "This expression can't be shown as rules."
    );
    expect(container.textContent).toContain("Current expression");
    // The builder starts empty rather than showing the stale blank rules.
    expect(
      container
        .querySelector('[data-testid="builder"]')
        ?.getAttribute("data-group-id")
    ).not.toBe("g");
  });

  // The cap is on the whole workflow, so each regex Condition shows it.
  it("shows when the workflow's regex patterns together are too long", () => {
    const calls = (from: number) =>
      Array.from(
        { length: 8 },
        (_, i) => `matchesRegex(${FIELD}, "^${from + i}${"a".repeat(150)}")`
      ).join(" || ");
    const conditionNode = (id: string, condition: string) =>
      ({
        id,
        type: "action",
        position: { x: 0, y: 0 },
        data: {
          type: "action",
          label: id,
          config: { actionType: "Condition", condition },
        },
      }) as WorkflowNode;
    const first = { actionType: "Condition", condition: calls(0) };
    getDefaultStore().set(nodesAtom, [conditionNode("c1", calls(0))]);
    render(first);
    expect(container.textContent).not.toContain(REGEX_WORKFLOW_COMPILE_ERROR);
    act(() =>
      getDefaultStore().set(nodesAtom, [
        conditionNode("c1", calls(0)),
        conditionNode("c2", calls(10)),
      ])
    );
    expect(container.textContent).toContain(REGEX_WORKFLOW_COMPILE_ERROR);
  });

  // Text with line breaks opens in Expression mode, which has its own branch.
  it("shows in Expression mode what stops the workflow saving", () => {
    const calls = (from: number) =>
      Array.from(
        { length: 8 },
        (_, i) => `matchesRegex(${FIELD}, "^${from + i}${"a".repeat(150)}")`
      ).join(" ||\n");
    const node = (id: string, condition: string) =>
      ({
        id,
        type: "action",
        position: { x: 0, y: 0 },
        data: {
          type: "action",
          label: id,
          config: { actionType: "Condition", condition },
        },
      }) as WorkflowNode;
    getDefaultStore().set(nodesAtom, [
      node("first", calls(0)),
      node("second", calls(10)),
    ]);
    render({ actionType: "Condition", condition: calls(0) });
    expect(container.querySelector('input[aria-label="expression"]')).not.toBe(
      null
    );
    expect(container.textContent).toContain(REGEX_WORKFLOW_COMPILE_ERROR);
    expect(container.textContent).toContain("won't save until this is fixed");

    act(() => getDefaultStore().set(nodesAtom, []));
    act(() => root.unmount());
    root = createRoot(container);
    render({
      actionType: "Condition",
      condition: `matchesRegex(${FIELD}, "(?=a)") ||\n${FIELD} === 1`,
    });
    const blocking = [...container.querySelectorAll("p.text-destructive")];
    expect(blocking.map((p) => p.textContent).join(" ")).toContain("Lookahead");
    expect(container.textContent).toContain("won't save until this is fixed");
  });
});
