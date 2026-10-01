// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SponsorGasField } from "@/components/workflow/config/sponsor-gas-field";

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

function render(value: unknown): void {
  act(() => {
    root.render(
      <SponsorGasField
        id="sponsorGas"
        label="Sponsor gas"
        onChange={vi.fn()}
        value={value}
      />
    );
  });
}

function toggle(): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>("#sponsorGas");
}

describe("SponsorGasField", () => {
  it("warns who pays once sponsorship is switched off", () => {
    // Off is a change of payer, not a preference: a wallet funded only with
    // the value it moves now fails at broadcast for want of native token.
    render(false);
    const text = container.textContent ?? "";
    expect(text).toContain("pays its own gas");
    expect(text).toContain("no gas credits");
    expect(text).toContain("fails at broadcast");
  });

  it('warns on the "false" string the editor may persist', () => {
    render("false");
    expect(container.textContent ?? "").toContain("pays its own gas");
  });

  it("stays quiet while sponsorship is on, including when unset", () => {
    for (const value of [undefined, null, true, "true"]) {
      render(value);
      expect(container.textContent ?? "").not.toContain("pays its own gas");
    }
  });

  it("reflects the resolved state on the switch itself", () => {
    render(undefined);
    expect(toggle()?.getAttribute("aria-checked")).toBe("true");
    render(false);
    expect(toggle()?.getAttribute("aria-checked")).toBe("false");
  });
});
