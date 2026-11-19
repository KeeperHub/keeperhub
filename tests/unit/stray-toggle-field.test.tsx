// @vitest-environment jsdom
// Save refuses a new toggle value that is neither on nor off, even when the
// form hides the toggle, so the form has to show it with a way to fix it.
import { act, type ReactElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { ActionConfigRenderer } from "@/components/workflow/config/action-config-renderer";
import { FailOnErrorSwitchField } from "@/components/workflow/config/fail-on-error-switch-field";
import { PlainSwitchField } from "@/components/workflow/config/plain-switch-field";
import { SponsorGasField } from "@/components/workflow/config/sponsor-gas-field";
import { TOGGLE_FIELD_RENDERERS } from "@/components/workflow/config/toggle-field-renderers";
import { registerFieldRenderer } from "@/lib/workflow/editor/extension-registry";
import { fieldIsSet } from "@/lib/workflow/editor/group-summary";
import { sponsorGasField } from "@/plugins/field-fragments";
import {
  type ActionConfigField,
  type ActionConfigFieldBase,
  isDefaultOnToggleField,
  isFieldShown,
  isShownOnlyToFix,
  toggleFieldTypes,
} from "@/plugins/registry";

const TEMPLATE = "{{@webhook:Webhook.flag}}";
const HINT =
  "Holds a template or other value, not on or off. It runs as saved, but a save refuses a new value like this.";
const LOCKED_HINT =
  "It is normally hidden with these settings, so it can only be reset here.";
const RESET = "Reset to default";
// A network sponsorship does not cover, so Sponsor gas is hidden.
const UNCOVERED_NETWORK = "999999999";
const COVERED_NETWORK = "1";

// The real toggle renderers, as lib/workflow/editor/extensions.tsx registers
// them (that file pulls in the whole editor).
for (const [type, renderer] of Object.entries(TOGGLE_FIELD_RENDERERS)) {
  registerFieldRenderer(type, renderer);
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

// Holds the config the way the node panel does, so a click's end state shows.
let saved: Record<string, unknown> = {};
// Writes the config from outside the form, as an AI edit or undo does.
let replaceConfig: (config: Record<string, unknown>) => void = () => undefined;

function Harness({
  initial,
  fields,
}: {
  initial: Record<string, unknown>;
  fields: ActionConfigField[];
}) {
  const [config, setConfig] = useState(initial);
  saved = config;
  replaceConfig = setConfig;
  return (
    <ActionConfigRenderer
      config={config}
      fields={fields}
      onUpdateConfig={(key, value) => {
        setConfig((current) => ({ ...current, [key]: value }));
      }}
    />
  );
}

function renderFields(
  config: Record<string, unknown>,
  { defaultExpanded = true }: { defaultExpanded?: boolean } = {}
): void {
  const fields: ActionConfigField[] = [
    {
      type: "group",
      label: "Advanced",
      defaultExpanded,
      fields: [sponsorGasField()],
    },
  ];
  act(() => {
    // A new key remounts, so each case starts from its own config.
    root.render(
      <Harness fields={fields} initial={config} key={JSON.stringify(config)} />
    );
  });
}

function sponsorToggle(): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>("#sponsorGas");
}

function resetButton(): HTMLButtonElement | undefined {
  return [...container.querySelectorAll("button")].find((button) =>
    button.textContent?.startsWith(RESET)
  );
}

describe("a Sponsor gas holding a stray value", () => {
  it("is shown with the hint when the network hides it", () => {
    for (const network of [UNCOVERED_NETWORK, TEMPLATE, undefined]) {
      renderFields({ network, sponsorGas: TEMPLATE });
      expect(sponsorToggle(), String(network)).not.toBeNull();
      expect(container.textContent).toContain(HINT);
    }
  });

  it("stays hidden while it holds on, off or nothing", () => {
    for (const sponsorGas of [true, false, "true", "false", undefined]) {
      renderFields({ network: UNCOVERED_NETWORK, sponsorGas });
      expect(sponsorToggle(), String(sponsorGas)).toBeNull();
    }
  });

  it("resets a hidden one to unset, and the field hides again", () => {
    renderFields({ network: UNCOVERED_NETWORK, sponsorGas: TEMPLATE });
    act(() => resetButton()?.click());
    expect(saved.sponsorGas).toBeUndefined();
    expect(sponsorToggle()).toBeNull();
    expect(container.textContent).not.toContain(HINT);
  });

  it("resets a visible one to unset, which reads as on", () => {
    renderFields({ network: COVERED_NETWORK, sponsorGas: TEMPLATE });
    act(() => resetButton()?.click());
    expect(saved.sponsorGas).toBeUndefined();
    expect(sponsorToggle()?.getAttribute("aria-checked")).toBe("true");
    expect(container.textContent).not.toContain(HINT);
  });

  it("opens its collapsed group", () => {
    renderFields(
      { network: UNCOVERED_NETWORK, sponsorGas: TEMPLATE },
      { defaultExpanded: false }
    );
    expect(sponsorToggle()).not.toBeNull();
    renderFields(
      { network: COVERED_NETWORK, sponsorGas: false },
      { defaultExpanded: false }
    );
    expect(sponsorToggle()).toBeNull();
  });

  it("counts in the collapsed group's summary", () => {
    const field = sponsorGasField();
    expect(
      fieldIsSet(field, { network: UNCOVERED_NETWORK, sponsorGas: TEMPLATE })
    ).toBe(true);
    expect(
      fieldIsSet(field, { network: UNCOVERED_NETWORK, sponsorGas: false })
    ).toBe(false);
  });
});

describe("isFieldShown", () => {
  const field = sponsorGasField();

  it("shows a hidden default-on toggle only while it holds a stray value", () => {
    const hidden = { network: UNCOVERED_NETWORK };
    expect(isFieldShown(field, { ...hidden, sponsorGas: TEMPLATE })).toBe(true);
    expect(isFieldShown(field, hidden)).toBe(false);
    expect(isFieldShown(field, { ...hidden, sponsorGas: false })).toBe(false);
  });

  it("shows it whenever its condition holds", () => {
    expect(isFieldShown(field, { network: COVERED_NETWORK })).toBe(true);
  });
});

describe("Ignore case holding a stray value", () => {
  function IgnoreCase({ initial }: { initial: unknown }) {
    const [config, setConfig] = useState<Record<string, unknown>>({
      ignoreCase: initial,
    });
    saved = config;
    return (
      <PlainSwitchField
        config={config}
        field={{
          key: "ignoreCase",
          label: "Ignore case",
          type: "switch",
          defaultValue: "false",
        }}
        onUpdateConfig={(key, value) =>
          setConfig((current) => ({ ...current, [key]: value }))
        }
      />
    );
  }

  it("resets to unset, which reads as off", () => {
    act(() => root.render(<IgnoreCase initial={TEMPLATE} />));
    act(() => resetButton()?.click());
    expect(saved.ignoreCase).toBeUndefined();
    expect(
      container.querySelector('[role="switch"]')?.getAttribute("aria-checked")
    ).toBe("false");
    expect(container.textContent).not.toContain(HINT);
  });
});

describe("the stray-value hint on every toggle", () => {
  const toggles: [
    string,
    (value: unknown, onReset: () => void, disabled: boolean) => ReactElement,
  ][] = [
    [
      "Sponsor gas",
      (value, onReset, disabled) => (
        <SponsorGasField
          disabled={disabled}
          id="t"
          label="Sponsor gas"
          onChange={(next) => next === undefined && onReset()}
          resetOnly={false}
          value={value}
        />
      ),
    ],
    [
      "Fail workflow on error",
      (value, onReset, disabled) => (
        <FailOnErrorSwitchField
          disabled={disabled}
          id="t"
          label="Fail workflow on error"
          onChange={(next) => next === undefined && onReset()}
          resetOnly={false}
          value={value}
        />
      ),
    ],
    [
      "Ignore case",
      (value, onReset, disabled) => (
        <PlainSwitchField
          config={{ ignoreCase: value }}
          disabled={disabled}
          field={{ key: "ignoreCase", label: "Ignore case", type: "switch" }}
          onUpdateConfig={(_key, next) => next === undefined && onReset()}
        />
      ),
    ],
  ];

  it("shows with a reset button for a stray value and not for on or off", () => {
    for (const [label, toggle] of toggles) {
      for (const value of [TEMPLATE, "maybe", 1, { on: true }]) {
        const onReset = vi.fn();
        act(() => root.render(toggle(value, onReset, false)));
        expect(container.textContent, String(value)).toContain(HINT);
        expect(
          container
            .querySelector('[role="switch"]')
            ?.getAttribute("aria-describedby")
        ).toContain("-stray");
        const button = resetButton();
        expect(button?.getAttribute("type")).toBe("button");
        // The accessible name keeps the visible text and adds the field.
        expect(button?.textContent).toBe(
          `${RESET} (${label === "Ignore case" ? "off" : "on"}), ${label}`
        );
        expect(button?.getAttribute("aria-describedby")).toMatch(/-stray$/);
        act(() => button?.click());
        expect(onReset).toHaveBeenCalledTimes(1);
      }
      for (const value of [true, false, "true", "false", undefined, null, ""]) {
        act(() => root.render(toggle(value, vi.fn(), false)));
        expect(container.textContent, String(value)).not.toContain(HINT);
        expect(resetButton()).toBeUndefined();
      }
    }
  });

  it("shows only the first sentence when the toggle is disabled", () => {
    for (const [, toggle] of toggles) {
      act(() => root.render(toggle(TEMPLATE, vi.fn(), true)));
      expect(container.textContent).toContain(HINT);
      expect(resetButton()).toBeUndefined();
    }
  });
});

describe("a stray Sponsor gas shown only to be fixed", () => {
  it("locks the switch, so a click cannot save off and hide it for good", () => {
    renderFields({ network: UNCOVERED_NETWORK, sponsorGas: TEMPLATE });
    const toggle = sponsorToggle();
    expect(toggle?.disabled).toBe(true);
    expect(container.textContent).toContain(LOCKED_HINT);
    act(() => toggle?.click());
    expect(saved.sponsorGas).toBe(TEMPLATE);
    act(() => resetButton()?.click());
    expect(saved.sponsorGas).toBeUndefined();
  });

  it("leaves the switch usable where the network shows it", () => {
    renderFields({ network: COVERED_NETWORK, sponsorGas: TEMPLATE });
    const toggle = sponsorToggle();
    expect(toggle?.disabled).toBe(false);
    expect(container.textContent).not.toContain(LOCKED_HINT);
    act(() => toggle?.click());
    expect(saved.sponsorGas).toBe(false);
    expect(sponsorToggle()).not.toBeNull();
  });
});

describe("a stray value that arrives after the panel opened", () => {
  it("opens the collapsed group", () => {
    renderFields(
      { network: UNCOVERED_NETWORK, sponsorGas: false },
      { defaultExpanded: false }
    );
    expect(sponsorToggle()).toBeNull();
    act(() =>
      replaceConfig({ network: UNCOVERED_NETWORK, sponsorGas: TEMPLATE })
    );
    expect(sponsorToggle()).not.toBeNull();
    expect(container.textContent).toContain(HINT);
  });
});

describe("a hidden toggle", () => {
  const field = { ...sponsorGasField(), hidden: true };
  const config = { network: UNCOVERED_NETWORK, sponsorGas: TEMPLATE };

  it("is never shown, counted or offered to fix", () => {
    expect(isFieldShown(field, config)).toBe(false);
    expect(isShownOnlyToFix(field, config)).toBe(false);
    expect(fieldIsSet(field, config)).toBe(false);
    act(() => {
      root.render(<Harness fields={[field]} initial={config} />);
    });
    expect(sponsorToggle()).toBeNull();
  });
});

describe("every toggle field type", () => {
  it("has a real renderer, and a default-on one locks when shown only to fix", () => {
    for (const type of toggleFieldTypes()) {
      expect(Object.hasOwn(TOGGLE_FIELD_RENDERERS, type), type).toBe(true);
      if (!isDefaultOnToggleField(type)) {
        continue;
      }
      const field: ActionConfigFieldBase = {
        key: "t",
        label: "T",
        type: type as ActionConfigFieldBase["type"],
        showWhen: { field: "mode", equals: "shown" },
      };
      const config = { mode: "hidden", t: TEMPLATE };
      expect(isShownOnlyToFix(field, config), type).toBe(true);
      const element = TOGGLE_FIELD_RENDERERS[type]({
        field,
        config,
        onUpdateConfig: vi.fn(),
      });
      act(() => root.render(element));
      expect(
        container.querySelector<HTMLButtonElement>("#t")?.disabled,
        type
      ).toBe(true);
      expect(resetButton(), type).toBeDefined();
    }
  });
});

describe("a read-only form with a stray Sponsor gas shown only to fix", () => {
  it("shows the first sentence only, with no Reset", () => {
    act(() => {
      root.render(
        <ActionConfigRenderer
          config={{ network: UNCOVERED_NETWORK, sponsorGas: TEMPLATE }}
          disabled
          fields={[sponsorGasField()]}
          onUpdateConfig={vi.fn()}
        />
      );
    });
    expect(container.textContent).toContain(HINT);
    expect(container.textContent).not.toContain(LOCKED_HINT);
    expect(resetButton()).toBeUndefined();
  });
});

describe("focus after Reset", () => {
  it("moves to the switch while the field stays", () => {
    renderFields({ network: COVERED_NETWORK, sponsorGas: TEMPLATE });
    act(() => resetButton()?.click());
    expect(document.activeElement).toBe(sponsorToggle());
  });

  it("moves to the group header when the field hides", () => {
    renderFields({ network: UNCOVERED_NETWORK, sponsorGas: TEMPLATE });
    act(() => resetButton()?.click());
    expect(sponsorToggle()).toBeNull();
    expect(document.activeElement?.tagName).toBe("BUTTON");
    expect(document.activeElement?.textContent).toContain("Advanced");
  });
});

describe("the collapsed group and stray values", () => {
  const failOnError: ActionConfigFieldBase = {
    key: "failOnError",
    label: "Fail workflow on error",
    type: "fail-on-error-switch",
  };

  it("opens again for a second stray value after the user shut it", () => {
    const fields: ActionConfigField[] = [
      {
        type: "group",
        label: "Advanced",
        fields: [sponsorGasField(), failOnError],
      },
    ];
    act(() => {
      root.render(
        <Harness
          fields={fields}
          initial={{ network: COVERED_NETWORK, sponsorGas: TEMPLATE }}
        />
      );
    });
    const header = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Advanced")
    );
    act(() => header?.click());
    expect(sponsorToggle()).toBeNull();
    act(() => replaceConfig({ ...saved, failOnError: TEMPLATE }));
    expect(sponsorToggle()).not.toBeNull();
  });

  it("stays shut for a stray plain switch its condition hides", () => {
    const fields: ActionConfigField[] = [
      {
        type: "group",
        label: "Advanced",
        fields: [
          {
            key: "ignoreCase",
            label: "Ignore case",
            type: "switch",
            showWhen: { field: "operator", equals: "contains" },
          },
        ],
      },
    ];
    act(() => {
      root.render(
        <Harness
          fields={fields}
          initial={{ operator: "isEmpty", ignoreCase: TEMPLATE }}
        />
      );
    });
    expect(container.textContent).not.toContain(HINT);
    // The header chevron turns sideways while the group is shut.
    expect(container.querySelector(".-rotate-90")).not.toBeNull();
  });
});
