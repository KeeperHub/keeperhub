// @vitest-environment jsdom
import { createStore, Provider } from "jotai";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
// The loader waits between retries; no real waiting in this test.
vi.mock("@/lib/sleep", () => ({ sleep: vi.fn().mockResolvedValue(undefined) }));
// Every test loads the list itself; nothing is kept between tests.
vi.mock("@/lib/hooks/use-cached-resource", () => ({
  readCachedResource: () => undefined,
  writeCachedResource: () => undefined,
}));

import "@/lib/workflow/editor/extensions";
import { ActionConfigRenderer } from "@/components/workflow/config/action-config-renderer";
import { configTransformFor } from "@/lib/workflow/editor/action-type-transition";
import { applyConfigUpdate } from "@/lib/workflow/editor/config-update";
import {
  setEditorSendModeChains,
  setEditorSendModeChainsFailed,
} from "@/lib/workflow/editor/send-mode-chains";
import {
  actionSwitchNotice,
  sendsPrivately,
} from "@/lib/workflow/editor/send-mode-editor";
import { selectedNodeAtom } from "@/lib/workflow/store";
import { type ActionConfigField, findActionById } from "@/plugins/registry";

const CHAINS = [
  {
    chainId: 1,
    name: "Ethereum",
    symbol: "ETH",
    chainType: "evm",
    isTestnet: false,
    isEnabled: true,
    usePrivateMempoolRpc: true,
  },
];

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_GAS_SPONSORSHIP_ENABLED", "true");
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  window.localStorage.clear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  setEditorSendModeChains(undefined);
  setEditorSendModeChainsFailed(false);
});

async function flush(): Promise<void> {
  for (let tick = 0; tick < 10; tick++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function retry(within: ParentNode): HTMLButtonElement | undefined {
  return [...within.querySelectorAll("button")].find((button) =>
    button.textContent?.startsWith("Retry")
  );
}

// Network, Send as and an Advanced group holding only Sponsor gas.
function writeFields(actionType = "web3/write-contract"): ActionConfigField[] {
  const out: ActionConfigField[] = [];
  for (const field of findActionById(actionType)?.configFields ?? []) {
    if (field.type === "group") {
      const kept = field.fields.filter((inner) => inner.key === "sponsorGas");
      if (kept.length > 0) {
        out.push({ ...field, fields: kept });
      }
    } else if (field.key === "network" || field.key === "sendMode") {
      out.push(field);
    }
  }
  return out;
}

async function render(
  config: Record<string, unknown>,
  disabled?: boolean
): Promise<void> {
  const store = createStore();
  store.set(selectedNodeAtom, "node-1");
  await act(async () => {
    root.render(
      <Provider store={store}>
        <ActionConfigRenderer
          config={config}
          disabled={disabled}
          fields={writeFields(String(config.actionType))}
          onUpdateConfig={() => undefined}
        />
      </Provider>
    );
    await Promise.resolve();
  });
  await flush();
}

function failLoads(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve({ ok: false, status: 500 }))
  );
}

function openAdvanced(): void {
  const toggle = [...container.querySelectorAll("button")].find(
    (button) => button.textContent?.trim() === "Advanced"
  );
  act(() => toggle?.click());
}

describe("Send as when the chain list does not load", () => {
  it("shows an error with Retry on the field and the network, instead of hiding Private relay", async () => {
    failLoads();
    await render({ actionType: "web3/write-contract", network: "1" });

    const error = container.querySelector(
      '[data-testid="send-mode-chains-error"]'
    );
    expect(error?.textContent).toContain(
      "The network list did not load, so Private relay is not offered."
    );
    expect(
      container.querySelector('[data-testid="send-mode-field"]')
    ).not.toBeNull();
    const network = document.getElementById("network");
    expect(network?.textContent).toContain("The network list did not load.");
    expect(network?.getAttribute("role")).toBe("status");

    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve({ ok: true, json: () => Promise.resolve(CHAINS) })
      )
    );
    await act(async () => {
      retry(error ?? container)?.click();
      await Promise.resolve();
    });
    await flush();
    expect(
      container.querySelector('[data-testid="send-mode-chains-error"]')
    ).toBeNull();
    expect(container.textContent).not.toContain("did not load");
    // Retry went away with the error: focus is on the Network select.
    expect(document.activeElement?.id).toBe("network");
    expect(document.activeElement?.tagName).toBe("BUTTON");
  });

  it("keeps focus on Network while a Retry loads, and announces the loading", async () => {
    failLoads();
    await render({ actionType: "web3/write-contract", network: "1" });
    let finish: (value: unknown) => void = () => undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          })
      )
    );
    const network = document.getElementById("network");
    await act(async () => {
      retry(network ?? container)?.click();
      await Promise.resolve();
    });
    await flush();
    const loading = document.getElementById("network");
    expect(loading?.getAttribute("role")).toBe("status");
    expect(loading?.textContent).toContain("Loading chains...");
    expect(document.activeElement).toBe(loading);

    await act(async () => {
      finish({ ok: true, json: () => Promise.resolve(CHAINS) });
      await Promise.resolve();
    });
    await flush();
    expect(document.activeElement?.id).toBe("network");
    expect(document.activeElement?.tagName).toBe("BUTTON");
  });

  it("offers Retry to a viewer too, since it only reloads the list", async () => {
    failLoads();
    await render({ actionType: "web3/write-contract", network: "1" }, true);
    const error = container.querySelector(
      '[data-testid="send-mode-chains-error"]'
    );
    expect(retry(error ?? container)).toBeDefined();
    expect(
      retry(document.getElementById("network") ?? container)
    ).toBeDefined();
  });

  it("tells the two Retry buttons apart for screen readers", async () => {
    failLoads();
    await render({ actionType: "web3/write-contract", network: "1" });
    const error = container.querySelector(
      '[data-testid="send-mode-chains-error"]'
    );
    expect(retry(error ?? container)?.textContent).toBe(
      "Retry loading networks for Send as"
    );
    expect(
      retry(document.getElementById("network") ?? container)?.textContent
    ).toBe("Retry");
  });
});

describe("an old (Flashbots) flag where the network does not resolve", () => {
  const NOTICE =
    "This step uses the private relay where its network has one, otherwise the public mempool.";

  function notice(): Element | null {
    return container.querySelector(
      '[data-testid="send-mode-unavailable-notice"]'
    );
  }

  function sponsorGas(): string | null | undefined {
    return container.querySelector("#sponsorGas")?.getAttribute("aria-checked");
  }

  it.each([
    ["a templated network", "{{@trigger:Webhook.chain}}"],
    ["a network the list does not have", "424242"],
  ])("shows Private relay with a neutral notice on %s", async (_, network) => {
    setEditorSendModeChains(CHAINS);
    await render({
      actionType: "web3/write-contract",
      network,
      usePrivateMempool: true,
      sponsorGas: true,
    });
    expect(container.querySelector("#sendMode")?.textContent).toBe(
      "Private relay"
    );
    expect(notice()?.textContent).toContain(NOTICE);
    expect(notice()?.className).toContain("bg-muted/50");
    // No PRIVATE badge: it may send publicly.
    expect(
      sendsPrivately({
        actionType: "web3/write-contract",
        network,
        usePrivateMempool: true,
      })
    ).toBe(false);
  });

  it("shows it as Private relay on Ethereum and public on Base, without that notice", async () => {
    setEditorSendModeChains([
      ...CHAINS,
      {
        ...CHAINS[0],
        chainId: 8453,
        name: "Base",
        usePrivateMempoolRpc: false,
      },
    ]);
    await render({
      actionType: "web3/write-contract",
      network: "1",
      usePrivateMempool: true,
    });
    expect(container.querySelector("#sendMode")?.textContent).toBe(
      "Private relay"
    );
    expect(notice()).toBeNull();

    act(() => root.unmount());
    root = createRoot(container);
    await render({
      actionType: "web3/write-contract",
      network: "8453",
      usePrivateMempool: true,
    });
    expect(notice()?.textContent).toContain(
      "Base has no private relay, so this step sends to the public mempool."
    );
  });

  it("shows Private relay with the notice once the list failed, Normal while it loads", async () => {
    let fail: (value: unknown) => void = () => undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise((resolve) => {
            fail = resolve;
          })
      )
    );
    const config = {
      actionType: "web3/write-contract",
      network: "1",
      usePrivateMempool: true,
    };
    await render(config);
    // Loading: Send as is hidden (Normal) and says nothing yet.
    expect(
      container.querySelector('[data-testid="send-mode-field"]')
    ).toBeNull();
    expect(notice()).toBeNull();

    failLoads();
    await act(async () => {
      fail({ ok: false, status: 500 });
      await Promise.resolve();
    });
    await flush();
    expect(container.querySelector("#sendMode")?.textContent).toBe(
      "Private relay"
    );
    expect(notice()?.textContent).toContain(NOTICE);
    // Sponsor gas mounting tries the load again; it fails again.
    openAdvanced();
    await flush();
    expect(sponsorGas()).toBe("false");
    expect(
      container.querySelector('[data-testid="sponsor-gas-send-as-hint"]')
        ?.textContent
    ).toContain("Off because Send as is Private relay");
  });

  it("resets an old flag on a switch to Batch while the list still loads", () => {
    // Loading: no list and no failure yet; the editor shows the flag as Normal.
    const before = {
      actionType: "web3/write-contract",
      network: "1",
      usePrivateMempool: true,
    };
    // As the side panel and the overlay write it.
    const after = applyConfigUpdate(
      null,
      before,
      "actionType",
      "web3/batch-write-contract",
      configTransformFor("actionType", "web3/batch-write-contract")
    ).config;
    expect(after).toMatchObject({
      sendMode: "transaction",
      usePrivateMempool: false,
    });
    // The network is not known yet, so the notice does not say how it sent.
    expect(actionSwitchNotice(before, after)?.notice).toBe(
      "Send as changed to Normal transaction: this step now sends to the public mempool on every network (Batch Write Contract has no private relay option yet)."
    );
  });

  it("warns on Batch, which a save refuses with the old flag there, that it still uses a relay", async () => {
    setEditorSendModeChains(CHAINS);
    await render({
      actionType: "web3/batch-write-contract",
      network: "{{@trigger:Webhook.chain}}",
      usePrivateMempool: true,
    });
    const warning = container.querySelector(
      '[data-testid="send-mode-unsupported-notice"]'
    );
    expect(warning?.textContent).toContain(
      "so it still sends through the private relay where its network has one, otherwise the public mempool."
    );
    expect(warning?.textContent).toContain(
      "on such a relay it fails before sending."
    );
    expect(warning?.className).toContain("bg-destructive/5");
  });
});
