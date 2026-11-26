// @vitest-environment jsdom
import { createStore, Provider } from "jotai";
import { act, type ReactNode, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// Both surfaces with their own write handlers; heavy children are stubs, but
// the step's fields (Network and the real Calls editor) are drawn for real.
vi.mock("@/components/overlays/overlay-provider", () => ({
  useOverlay: () => ({ push: vi.fn(), closeAll: vi.fn(), open: vi.fn() }),
}));
vi.mock("@/components/overlays/overlay-header", () => ({
  SmartOverlayHeader: () => null,
}));
vi.mock("@/components/failure-alerts/workflow-failure-alerts", () => ({
  WorkflowFailureAlerts: () => null,
}));
vi.mock("@/components/workflow/workflow-runs", () => ({
  WorkflowRuns: () => null,
}));
vi.mock("@/components/workflow/version-history-content", () => ({
  VersionHistoryContent: () => null,
}));
vi.mock("@/components/workflow/config/trigger-config", () => ({
  TriggerConfig: () => null,
}));
vi.mock("@/components/workflow/config/action-grid", () => ({
  ActionGrid: () => null,
}));
vi.mock("@/components/projects/project-select", () => ({
  ProjectSelect: () => null,
}));
vi.mock("@/components/tags/tag-select", () => ({ TagSelect: () => null }));
vi.mock("@/components/workflow/config/action-config", async () => {
  const { ActionConfigRenderer } = await import(
    "@/components/workflow/config/action-config-renderer"
  );
  const { findActionById, flattenConfigFields } = await import(
    "@/plugins/registry"
  );
  return {
    ActionConfig: ({
      config,
      onUpdateConfig,
    }: {
      config: Record<string, unknown>;
      onUpdateConfig: (key: string, value: unknown) => void;
    }) => (
      <div>
        <button
          onClick={() =>
            onUpdateConfig("actionType", "web3/batch-write-contract")
          }
          type="button"
        >
          Switch to Batch
        </button>
        <ActionConfigRenderer
          config={config}
          fields={flattenConfigFields(
            findActionById(String(config.actionType))?.configFields ?? []
          ).filter((field) => ["network", "calls"].includes(field.key))}
          onUpdateConfig={onUpdateConfig}
        />
      </div>
    ),
  };
});

import "@/lib/workflow/editor/extensions";
import { ConfigurationOverlay } from "@/components/overlays/configuration-overlay";
import { PanelInner } from "@/components/workflow/node-config-panel";
import type { Integration } from "@/lib/api-client";
import { integrationsAtom } from "@/lib/integrations-store";
import { setEditorSendModeChains } from "@/lib/workflow/editor/send-mode-chains";
import {
  nodesAtom,
  propertiesPanelActiveTabAtom,
  selectedNodeAtom,
  type WorkflowNode,
} from "@/lib/workflow/store";

const CHAINS = [
  {
    chainId: 1,
    name: "Ethereum",
    symbol: "ETH",
    usePrivateMempoolRpc: true,
    chainType: "evm",
    isTestnet: false,
    isEnabled: true,
  },
];
const RELAY_WRITE = {
  actionType: "web3/write-contract",
  network: "1",
  sendMode: "private-relay",
  usePrivateMempool: true,
  contractAddress: "0xabc",
  integrationId: "wallet-1",
};

let container: HTMLDivElement;
let root: Root;
let store: ReturnType<typeof createStore>;

beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve({ ok: true, json: () => Promise.resolve(CHAINS) })
    )
  );
  setEditorSendModeChains(CHAINS);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  store = createStore();
  const node = {
    id: "node-1",
    position: { x: 0, y: 0 },
    data: { label: "Write", type: "action", config: RELAY_WRITE },
  } as WorkflowNode;
  store.set(nodesAtom, [node]);
  store.set(selectedNodeAtom, "node-1");
  store.set(propertiesPanelActiveTabAtom, "properties");
  // The step's wallet exists, so the panel keeps it.
  store.set(integrationsAtom, [
    { id: "wallet-1", type: "web3", name: "Wallet" } as Integration,
  ]);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function config(): Record<string, unknown> | undefined {
  return store.get(nodesAtom)[0]?.data.config;
}

function notice(): HTMLElement | null {
  return container.querySelector('[data-testid="network-send-mode-notice"]');
}

function click(label: string, scope: ParentNode = container): void {
  const target = [...scope.querySelectorAll("button")].find(
    (button) => button.textContent === label
  );
  act(() => target?.click());
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

// StrictMode, as in the dev server: the Calls editor writes its first row on mount.
async function render(surface: ReactNode): Promise<void> {
  await act(async () => {
    root.render(
      <StrictMode>
        <Provider store={store}>{surface}</Provider>
      </StrictMode>
    );
    await Promise.resolve();
  });
}

const SURFACES: [string, () => ReactNode][] = [
  ["side panel", () => <PanelInner />],
  ["overlay", () => <ConfigurationOverlay overlayId="config" />],
];

describe.each(SURFACES)(
  "Action switch notice with the Calls editor (%s)",
  (_name, surface) => {
    it("stays after the Calls editor fills its first row; Undo puts back the step", async () => {
      await render(surface());

      click("Switch to Batch");
      await settle();

      // The Calls editor wrote its empty row, and the notice is still there.
      expect(typeof config()?.calls).toBe("string");
      expect(config()).toMatchObject({
        actionType: "web3/batch-write-contract",
        sendMode: "transaction",
      });
      expect(notice()?.textContent).toContain(
        "Batch Write Contract can't send through the private relay yet."
      );

      click("Undo", notice() ?? container);

      expect(config()).toEqual(RELAY_WRITE);
      expect(notice()).toBeNull();
    });

    it("goes once the user edits the new step, so Undo cannot drop the edit", async () => {
      await render(surface());
      click("Switch to Batch");
      await settle();
      expect(notice()).not.toBeNull();

      // The Calls row's contract address (a contentEditable template input).
      const address = container.querySelector<HTMLElement>(
        '[id^="calls-addr-"]'
      );
      expect(address).not.toBeNull();
      await act(async () => {
        if (address) {
          address.textContent = "0x1234";
          address.dispatchEvent(new Event("input", { bubbles: true }));
        }
        await Promise.resolve();
      });
      await settle();

      expect(String(config()?.calls)).toContain("0x1234");
      expect(notice()).toBeNull();
    });
  }
);
