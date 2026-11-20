// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Select, SelectContent, SelectItem } from "@/components/ui/select";
import { PlainSwitchField } from "@/components/workflow/config/plain-switch-field";

import {
  groupedSelectLabel,
  groupSelectOptions,
  qualifiedOptionLabel,
} from "@/lib/workflow/editor/select-option-groups";
import {
  type ActionConfigFieldBase,
  readToggle,
  toggleDefault,
  toggleRuleOf,
} from "@/plugins/registry";

describe("groupSelectOptions", () => {
  it("puts consecutive options of one group under one header, in order", () => {
    const groups = groupSelectOptions([
      { value: "a", label: "A", group: "Text" },
      { value: "b", label: "B", group: "Text" },
      { value: "c", label: "C", group: "Number" },
      { value: "d", label: "D" },
    ]);
    expect(groups.map((group) => group.label)).toEqual(["Text", "Number", ""]);
    expect(groups[0].options.map((option) => option.value)).toEqual(["a", "b"]);
  });

  it("keeps an ungrouped list as one headerless group", () => {
    const groups = groupSelectOptions([
      { value: "a", label: "A" },
      { value: "b", label: "B" },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].label).toBe("");
  });
});

// [stored value, field default, on]: how a plain switch reads its value, the
// rule its step applies.
const SWITCH_READS: [unknown, string | undefined, boolean][] = [
  [true, undefined, true],
  ["true", undefined, true],
  [undefined, "true", true],
  [false, "true", false],
  [undefined, "false", false],
  [undefined, undefined, false],
  // Blank reads as unset; anything else is off.
  ["", "true", true],
  [null, "true", true],
  ["{{@a:A.on}}", "true", false],
  ["True", undefined, false],
];

describe("a plain switch reads its value", () => {
  it('reads true or "true", the default while unset, and anything else as off', () => {
    for (const [value, switchDefault, on] of SWITCH_READS) {
      expect(
        readToggle({ switchDefault }, value),
        JSON.stringify([value, switchDefault])
      ).toBe(on);
    }
  });
});

describe("a toggle's rule", () => {
  it("is decided by the field type, in one place", () => {
    expect(toggleRuleOf({ type: "fail-on-error-switch" })).toBe("default-on");
    expect(toggleRuleOf({ type: "gas-sponsorship-switch" })).toBe("default-on");
    expect(toggleRuleOf({ type: "switch", defaultValue: "true" })).toEqual({
      switchDefault: "true",
    });
  });

  it("reads a default-on toggle as on unless it resolves to false", () => {
    const reads: [unknown, boolean][] = [
      [undefined, true],
      ["", true],
      [true, true],
      ["true", true],
      [false, false],
      ["false", false],
    ];
    for (const [value, on] of reads) {
      expect(readToggle("default-on", value), JSON.stringify(value)).toBe(on);
    }
  });

  it("gives an unset toggle's default through the same reading", () => {
    const fields: Pick<ActionConfigFieldBase, "type" | "defaultValue">[] = [
      { type: "fail-on-error-switch" },
      { type: "gas-sponsorship-switch" },
      { type: "switch", defaultValue: "true" },
      { type: "switch", defaultValue: "false" },
      { type: "switch" },
    ];
    for (const field of fields) {
      expect(
        toggleDefault({ key: "k", label: "K", ...field }),
        JSON.stringify(field)
      ).toBe(readToggle(toggleRuleOf(field), undefined));
    }
  });
});

describe("PlainSwitchField", () => {
  const field: ActionConfigFieldBase = {
    key: "ignoreCase",
    label: "Ignore case",
    type: "switch",
    defaultValue: "false",
    helpText: "Match text whatever its letter case.",
  };
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(() => root.unmount());
    container.remove();
  });

  async function render(
    config: Record<string, unknown>,
    onUpdateConfig = vi.fn()
  ): Promise<HTMLElement> {
    await act(async () =>
      root.render(
        <PlainSwitchField
          config={config}
          field={field}
          onUpdateConfig={onUpdateConfig}
        />
      )
    );
    const toggle = container.querySelector<HTMLElement>('[role="switch"]');
    if (!toggle) {
      throw new Error("no switch rendered");
    }
    return toggle;
  }

  it("starts off, with its label and help text", async () => {
    const toggle = await render({});
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(container.textContent).toContain("Ignore case");
    expect(container.textContent).toContain(
      "Match text whatever its letter case."
    );
  });

  it("writes a boolean when toggled", async () => {
    const onUpdateConfig = vi.fn();
    const toggle = await render({}, onUpdateConfig);
    await act(async () => toggle.click());
    expect(onUpdateConfig).toHaveBeenCalledWith("ignoreCase", true);
  });

  it("shows a stored true as on", async () => {
    const toggle = await render({ ignoreCase: true });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
  });

  it("shows each stored value as the step reads it", async () => {
    for (const [value, switchDefault, on] of SWITCH_READS) {
      await act(async () =>
        root.render(
          <PlainSwitchField
            config={value === undefined ? {} : { ignoreCase: value }}
            field={{ ...field, defaultValue: switchDefault }}
            onUpdateConfig={vi.fn()}
          />
        )
      );
      const toggle = container.querySelector('[role="switch"]');
      expect(
        toggle?.getAttribute("aria-checked"),
        JSON.stringify([value, switchDefault])
      ).toBe(String(on));
    }
  });
});

describe("groupedSelectLabel", () => {
  const options = [
    { value: "contains", label: "contains", group: "Text" },
    { value: "arrayContains", label: "contains", group: "Array" },
    { value: "startsWith", label: "starts with", group: "Text" },
    { value: "plain", label: "plain" },
  ];

  it("names the group only where the label repeats", () => {
    expect(groupedSelectLabel(options, "contains")).toBe("Text: contains");
    expect(groupedSelectLabel(options, "arrayContains")).toBe(
      "Array: contains"
    );
    expect(groupedSelectLabel(options, "startsWith")).toBe("starts with");
    expect(groupedSelectLabel(options, "plain")).toBe("plain");
    expect(groupedSelectLabel(options, "missing")).toBeUndefined();
  });

  it("always names the group in the full label used by messages", () => {
    expect(qualifiedOptionLabel(options, "startsWith")).toBe(
      "Text: starts with"
    );
  });
});

describe("SelectItem hints and SwitchField help", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(() => root.unmount());
    container.remove();
  });

  it("shows an option's hint as visible text in the open list", async () => {
    await act(async () =>
      root.render(
        <Select open value="a">
          <SelectContent>
            <SelectItem description="Text includes the value" value="a">
              contains
            </SelectItem>
          </SelectContent>
        </Select>
      )
    );
    const option = document.body.querySelector('[role="option"]');
    expect(option?.textContent).toContain("contains");
    expect(option?.textContent).toContain("Text includes the value");
    const describedBy = option?.getAttribute("aria-describedby");
    expect(document.getElementById(describedBy ?? "")?.textContent).toBe(
      "Text includes the value"
    );
  });

  it("links the switch to its help text for screen readers", async () => {
    await act(async () =>
      root.render(
        <PlainSwitchField
          config={{}}
          field={{
            key: "ignoreCase",
            label: "Ignore case",
            type: "switch",
            helpText: "Match text whatever its letter case.",
          }}
          onUpdateConfig={vi.fn()}
        />
      )
    );
    const toggle = container.querySelector('[role="switch"]');
    const describedBy = toggle?.getAttribute("aria-describedby");
    expect(describedBy).toBe("ignoreCase-description");
    expect(document.getElementById(describedBy ?? "")?.textContent).toBe(
      "Match text whatever its letter case."
    );
  });
});
