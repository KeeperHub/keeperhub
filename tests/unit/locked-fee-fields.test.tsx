// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { ActionConfigRenderer } from "@/components/workflow/config/action-config-renderer";
import {
  SPONSORSHIP_GAS_SETTINGS_DOC_URL,
  UNSPONSORED_ONLY_FIELD_KEYS,
} from "@/lib/web3/unsponsored-only-fields";
import {
  type ActionConfigFieldBase,
  buildExampleConfig,
  findActionById,
  flattenConfigFields,
  isFieldEnabled,
  isFieldShown,
} from "@/plugins/registry";

const COVERED_NETWORK = "1";
const UNCOVERED_NETWORK = "999999999";

function feeFields(actionId: string): ActionConfigFieldBase[] {
  const fields = flattenConfigFields(
    findActionById(actionId)?.configFields ?? []
  );
  return UNSPONSORED_ONLY_FIELD_KEYS.map((key) => {
    const field = fields.find((candidate) => candidate.key === key);
    if (!field) {
      throw new Error(`${actionId} has no ${key} field`);
    }
    return field;
  });
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_GAS_SPONSORSHIP_ENABLED", "true");
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
  vi.unstubAllEnvs();
});

function render(
  fields: ActionConfigFieldBase[],
  config: Record<string, unknown>
): void {
  act(() => {
    root.render(
      <ActionConfigRenderer
        config={config}
        fields={fields}
        onUpdateConfig={() => undefined}
      />
    );
  });
}

function textbox(key: string): HTMLElement | null {
  return container.querySelector<HTMLElement>(`#${key}`);
}

describe("Write Contract fee settings while sponsored", () => {
  const fields = feeFields("web3/write-contract");

  it("shows the fee fields but locks them while the node would be sponsored", () => {
    const config = { network: COVERED_NETWORK, sponsorGas: true };
    render(fields, config);

    for (const field of fields) {
      expect(isFieldShown(field, config)).toBe(true);
      expect(isFieldEnabled(field, config)).toBe(false);
      const input = textbox(field.key);
      expect(input?.getAttribute("contenteditable")).toBe("false");
      expect(input?.getAttribute("aria-disabled")).toBe("true");
      const hint = container.querySelector(
        `[data-testid="field-locked-${field.key}"]`
      );
      expect(hint?.textContent).toContain("Turn off Sponsor gas to set this.");
      expect(hint?.querySelector("a")?.getAttribute("href")).toBe(
        SPONSORSHIP_GAS_SETTINGS_DOC_URL
      );
    }
  });

  it.each([
    { network: COVERED_NETWORK, sponsorGas: false },
    { network: UNCOVERED_NETWORK },
    { network: COVERED_NETWORK, usePrivateMempool: true },
  ])("unlocks the fee fields when the node pays its own gas: %j", (config) => {
    render(fields, config);

    for (const field of fields) {
      expect(isFieldEnabled(field, config)).toBe(true);
      expect(textbox(field.key)?.getAttribute("contenteditable")).toBe("true");
      expect(
        container.querySelector(`[data-testid="field-locked-${field.key}"]`)
      ).toBeNull();
    }
  });

  it("leaves locked fee fields out of the generation example", () => {
    const example = buildExampleConfig("web3/write-contract", [
      { key: "network", label: "Network", type: "text", example: "1" },
      ...fields,
    ]);
    for (const key of UNSPONSORED_ONLY_FIELD_KEYS) {
      expect(example).not.toHaveProperty(key);
    }
  });
});

describe("Batch Write Contract fee settings", () => {
  it("are never locked", () => {
    const fields = feeFields("web3/batch-write-contract");
    const config = { network: COVERED_NETWORK, sponsorGas: true };
    render(fields, config);

    for (const field of fields) {
      expect(isFieldEnabled(field, config)).toBe(true);
      expect(textbox(field.key)?.getAttribute("contenteditable")).toBe("true");
    }
  });
});
