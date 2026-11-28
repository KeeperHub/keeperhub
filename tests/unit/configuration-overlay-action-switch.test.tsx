// @vitest-environment jsdom
import { createStore, Provider } from "jotai";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// The overlay's own handleUpdateConfig is under test; its heavy children are stubs.
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
// The step's fields as the real renderer draws them, plus an action switch.
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
        <button
          onClick={() => onUpdateConfig("integrationId", "picked")}
          type="button"
        >
          Pick integration
        </button>
        <ActionConfigRenderer
          config={config}
          fields={flattenConfigFields(
            findActionById(String(config.actionType))?.configFields ?? []
          ).filter((field) => field.key === "network")}
          onUpdateConfig={onUpdateConfig}
        />
      </div>
    ),
  };
});

import "@/lib/workflow/editor/extensions";
import { ConfigurationOverlay } from "@/components/overlays/configuration-overlay";
import { setEditorSendModeChains } from "@/lib/workflow/editor/send-mode-chains";
import {
  isWorkflowOwnerAtom,
  nodesAtom,
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

async function render(): Promise<void> {
  await act(async () => {
    root.render(
      <Provider store={store}>
        <ConfigurationOverlay overlayId="config" />
      </Provider>
    );
    await Promise.resolve();
  });
}

describe("Configuration overlay action switch", () => {
  it("resets Send as to Normal with the side panel's notice; Undo puts back the step", async () => {
    await render();

    click("Switch to Batch");

    expect(config()).toMatchObject({
      actionType: "web3/batch-write-contract",
      sendMode: "transaction",
      usePrivateMempool: false,
    });
    expect(notice()?.textContent).toContain(
      "Batch Write Contract can't send through the private relay yet."
    );

    click("Undo", notice() ?? container);

    expect(config()).toEqual(RELAY_WRITE);
    expect(notice()).toBeNull();
  });

  it("drops the notice on a manual integration pick, so Undo cannot revert it", async () => {
    await render();
    click("Switch to Batch");
    expect(notice()).not.toBeNull();

    click("Pick integration");

    expect(notice()).toBeNull();
    expect(config()?.integrationId).toBe("picked");
  });

  it("ignores writes from a viewer", async () => {
    store.set(isWorkflowOwnerAtom, false);
    await render();

    click("Switch to Batch");
    click("Pick integration");

    expect(config()).toEqual(RELAY_WRITE);
    expect(notice()).toBeNull();
  });
});
