// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConditionQueryBuilder } from "@/components/workflow/condition-query-builder";
import type { ConditionGroup } from "@/lib/workflow/nodes/condition/builder-types";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function regexGroup(pattern: string): ConditionGroup {
  return {
    id: "g",
    logic: "AND",
    rules: [
      {
        id: "r",
        leftOperand: "{{@n1:Webhook.value}}",
        operator: "matchesRegex",
        rightOperand: pattern,
      },
    ],
  };
}

function render(pattern: string, onChange = vi.fn()): HTMLInputElement {
  act(() =>
    root.render(
      <ConditionQueryBuilder group={regexGroup(pattern)} onChange={onChange} />
    )
  );
  const input = container.querySelector<HTMLInputElement>(
    'input[aria-label="Regex pattern"]'
  );
  if (!input) {
    throw new Error("no pattern field");
  }
  return input;
}

describe("matches regex rule in the visual builder", () => {
  it("offers a plain pattern field, not the reference picker", () => {
    const input = render("^0x");
    expect(input.placeholder).toBe("Pattern, e.g. ^VAULT_");
    expect(input.value).toBe("^0x");
    expect(input.getAttribute("aria-invalid")).toBeNull();
    expect(container.textContent).not.toContain("Lookahead");
    const hint = container.querySelector(
      `[id="${input.getAttribute("aria-describedby")}"]`
    );
    expect(hint?.textContent).toContain("^ start, $ end");
  });

  it("shows a pattern that cannot run under the rule, linked to the field", () => {
    const input = render("^(?=EMSP)");
    const describedBy = input.getAttribute("aria-describedby");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(describedBy).toBeTruthy();
    const message = container.querySelector(`[id="${describedBy}"]`);
    expect(message?.textContent).toContain("Lookahead and lookbehind");
  });

  it("flags a pattern taken from another node", () => {
    render("{{@n2:Webhook.pattern}}");
    expect(container.textContent).toContain("not taken from another node");
  });

  it("gives does not match regex the same pattern field", () => {
    act(() =>
      root.render(
        <ConditionQueryBuilder
          group={{
            id: "g",
            logic: "AND",
            rules: [
              {
                id: "r",
                leftOperand: "{{@n1:Webhook.value}}",
                operator: "notMatchesRegex",
                rightOperand: "(?=a)",
              },
            ],
          }}
          onChange={vi.fn()}
        />
      )
    );
    expect(
      container.querySelector('input[aria-label="Regex pattern"]')
    ).not.toBeNull();
    expect(container.textContent).toContain("Lookahead and lookbehind");
  });

  it("announces the error through a live region that is always mounted", () => {
    vi.useFakeTimers();
    try {
      render("^(?=EMSP)");
      const live = container.querySelector('[aria-live="polite"]');
      expect(live?.textContent).toContain("Lookahead and lookbehind");
      render("^EMSP_");
      // The check waits for a pause in typing.
      act(() => {
        vi.advanceTimersByTime(400);
      });
      expect(container.querySelector('[aria-live="polite"]')?.textContent).toBe(
        ""
      );
    } finally {
      vi.useRealTimers();
    }
  });

  // The rule takes the pattern as typed, so no Expression-mode advice.
  it("words the quote error for the rule, not Expression mode", () => {
    render('"ok"');
    expect(container.textContent).toContain("wrapped in quotes");
    expect(container.textContent).not.toContain("Expression mode");
  });

  it("says how to match braces typed in the pattern", () => {
    render("^{{name}}$");
    expect(container.textContent).toContain(
      "To match braces, put a backslash before each one, as in \\{\\{;"
    );
    expect(container.textContent).not.toContain("Expression mode");
  });

  it("puts the error in the live region once, not twice", () => {
    render("^(?=EMSP)");
    const occurrences = container.textContent?.split(
      "Lookahead and lookbehind"
    ).length;
    expect(occurrences).toBe(2);
  });

  it("stays quiet while the pattern is empty", () => {
    const input = render("");
    expect(input.getAttribute("aria-invalid")).toBeNull();
  });
});
