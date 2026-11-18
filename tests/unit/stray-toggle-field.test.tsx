// @vitest-environment jsdom
// Save refuses a toggle holding anything but on or off, even when the form
// hides it, so the form has to show it with a way to fix it.
import { act } from "react";
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
const HINT = "This was saved as something other than on or off.";
// A network sponsorship does not cover, so Sponsor gas is hidden.
const UNCOVERED_NETWORK = "999999999";

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

function renderFields(
  config: Record<string, unknown>,
  onUpdateConfig = vi.fn()
): void {
  const fields: ActionConfigField[] = [
    {
      type: "group",
      label: "Advanced",
      defaultExpanded: true,
      fields: [sponsorGasField()],
    },
  ];
  act(() => {
    root.render(
      <ActionConfigRenderer
        config={config}
        fields={fields}
        onUpdateConfig={onUpdateConfig}
      />
    );
  });
}

function sponsorToggle(): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>("#sponsorGas");
}

describe("a hidden Sponsor gas holding a stray value", () => {
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

  it("is fixed by turning it off and on", () => {
    const onUpdateConfig = vi.fn();
    renderFields(
      { network: UNCOVERED_NETWORK, sponsorGas: TEMPLATE },
      onUpdateConfig
    );
    act(() => sponsorToggle()?.click());
    expect(onUpdateConfig).toHaveBeenLastCalledWith("sponsorGas", false);
    renderFields(
      { network: UNCOVERED_NETWORK, sponsorGas: false },
      onUpdateConfig
    );
    expect(container.textContent).not.toContain(HINT);
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

describe("the stray-value hint on every toggle", () => {
  it("shows under each toggle for a stray value and not for on or off", () => {
    const toggles = [
      (value: unknown) => (
        <SponsorGasField
          id="t"
          label="Sponsor gas"
          onChange={vi.fn()}
          value={value}
        />
      ),
      (value: unknown) => (
        <FailOnErrorSwitchField
          id="t"
          label="Fail workflow on error"
          onChange={vi.fn()}
          value={value}
        />
      ),
      (value: unknown) => (
        <PlainSwitchField
          config={{ ignoreCase: value }}
          field={{ key: "ignoreCase", label: "Ignore case", type: "switch" }}
          onUpdateConfig={vi.fn()}
        />
      ),
    ];
    for (const toggle of toggles) {
      for (const value of [TEMPLATE, "maybe", 1]) {
        act(() => root.render(toggle(value)));
        expect(container.textContent, String(value)).toContain(HINT);
        const described = container
          .querySelector('[role="switch"]')
          ?.getAttribute("aria-describedby");
        expect(described).toContain("-stray");
      }
      for (const value of [true, false, "true", "false", undefined, null, ""]) {
        act(() => root.render(toggle(value)));
        expect(container.textContent, String(value)).not.toContain(HINT);
      }
    }
  });
});
