// @vitest-environment jsdom
// Save refuses a toggle holding anything but on or off, even when the form
// hides it, so the form has to show it with a way to fix it.
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
import type { ActionConfigField } from "@/plugins/registry";

const TEMPLATE = "{{@webhook:Webhook.flag}}";
const HINT =
  "Holds a template or other value, not on or off, so this workflow won't save.";
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
      onChange={(checked) => onUpdateConfig(field.key, checked)}
      onReset={() => onUpdateConfig(field.key, undefined)}
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

function Harness({
  initial,
  fields,
}: {
  initial: Record<string, unknown>;
  fields: ActionConfigField[];
}) {
  const [config, setConfig] = useState(initial);
  saved = config;
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
  return [...container.querySelectorAll("button")].find(
    (button) => button.textContent === RESET
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
          onChange={vi.fn()}
          onReset={onReset}
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
          onChange={vi.fn()}
          onReset={onReset}
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
        expect(button?.getAttribute("aria-label")).toBe(
          `Reset ${label} to default`
        );
        expect(button?.className).toContain("min-h-6");
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
