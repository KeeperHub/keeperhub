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
import { registerFieldRenderer } from "@/lib/workflow/editor/extension-registry";
import { fieldIsSet } from "@/lib/workflow/editor/group-summary";
import { sponsorGasField } from "@/plugins/field-fragments";
import {
  type ActionConfigField,
  isFieldShown,
  isShownOnlyToFix,
} from "@/plugins/registry";

const TEMPLATE = "{{@webhook:Webhook.flag}}";
const HINT =
  "Holds a template or other value, not on or off. A save refuses a new value like this.";
const LOCKED_HINT =
  "This setting is hidden for the current choices, so reset it.";
const RESET = "Reset to default";
// A network sponsorship does not cover, so Sponsor gas is hidden.
const UNCOVERED_NETWORK = "999999999";
const COVERED_NETWORK = "1";

// Same wiring as the real renderer in lib/workflow/editor/extensions.tsx,
// which pulls in the whole editor.
registerFieldRenderer(
  "gas-sponsorship-switch",
  ({ field, config, onUpdateConfig, disabled }) => (
    <SponsorGasField
      disabled={disabled}
      id={field.key}
      key={field.key}
      label={field.label}
      onChange={(next) => onUpdateConfig(field.key, next)}
      resetOnly={isShownOnlyToFix(field, config)}
      value={config[field.key]}
    />
  )
);

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
        expect(button?.textContent).toBe(`${RESET} (${label})`);
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
  const config = { network: COVERED_NETWORK, sponsorGas: TEMPLATE };

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
