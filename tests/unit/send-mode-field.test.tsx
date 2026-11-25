// @vitest-environment jsdom
import { createStore, Provider } from "jotai";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import "@/lib/workflow/editor/extensions";
import { ActionConfigRenderer } from "@/components/workflow/config/action-config-renderer";
import {
  legacyRelayNotice,
  useEditorNotice,
} from "@/components/workflow/config/send-mode-field";
import { SendModeBadge } from "@/components/workflow/nodes/action-node";
import { setEditorSendModeChains } from "@/lib/workflow/editor/send-mode-chains";
import {
  chooseNetwork,
  pickSendMode,
  SPONSOR_ON_NOTICE,
} from "@/lib/workflow/editor/send-mode-editor";
import { currentWorkflowIdAtom, selectedNodeAtom } from "@/lib/workflow/store";
import { type ActionConfigField, findActionById } from "@/plugins/registry";

const EVM = { chainType: "evm", isTestnet: false, isEnabled: true };
const CHAINS = [
  {
    chainId: 1,
    name: "Ethereum",
    symbol: "ETH",
    usePrivateMempoolRpc: true,
    ...EVM,
  },
  {
    chainId: 8453,
    name: "Base",
    symbol: "ETH",
    usePrivateMempoolRpc: false,
    ...EVM,
  },
];

let container: HTMLDivElement;
let root: Root;
let latest: Record<string, unknown> = {};

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_GAS_SPONSORSHIP_ENABLED", "true");
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
  window.localStorage.clear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  vi.restoreAllMocks();
  act(() => root.unmount());
  container.remove();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

// Network, Send as and an Advanced group holding only Sponsor gas.
function relevantFields(actionType: string): ActionConfigField[] {
  const out: ActionConfigField[] = [];
  for (const entry of findActionById(actionType)?.configFields ?? []) {
    if (entry.type === "group") {
      const kept = entry.fields.filter((inner) => inner.key === "sponsorGas");
      if (kept.length > 0) {
        out.push({ ...entry, fields: kept });
      }
    } else if (entry.key === "network" || entry.key === "sendMode") {
      out.push(entry);
    }
  }
  return out;
}

function Harness({ initial }: { initial: Record<string, unknown> }) {
  const [config, setConfig] = useState(initial);
  latest = config;
  const fields = relevantFields(String(initial.actionType));
  return (
    <ActionConfigRenderer
      config={config}
      fields={fields}
      onUpdateConfig={(key, value) =>
        setConfig((current) => ({ ...current, [key]: value }))
      }
    />
  );
}

async function render(
  initial: Record<string, unknown>,
  ids = { workflow: "wf-1", node: "node-1" }
): Promise<void> {
  const store = createStore();
  store.set(currentWorkflowIdAtom, ids.workflow);
  store.set(selectedNodeAtom, ids.node);
  await act(async () => {
    root.render(
      <Provider store={store}>
        <Harness initial={initial} />
      </Provider>
    );
    await Promise.resolve();
  });
}

// Unmounts (running the delayed "seen" check), then renders again.
async function remount(
  initial: Record<string, unknown>,
  ids?: { workflow: string; node: string }
): Promise<void> {
  act(() => root.unmount());
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  root = createRoot(container);
  await render(initial, ids);
}

function field(): HTMLElement | null {
  return container.querySelector('[data-testid="send-mode-field"]');
}

function byTestId(id: string): HTMLElement | null {
  return container.querySelector(`[data-testid="${id}"]`);
}

function button(label: string, within: ParentNode = container) {
  return [...within.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === label
  );
}

// Focus moves after the change renders.
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function openAdvanced(): void {
  const toggle = [...container.querySelectorAll("button")].find(
    (button) => button.textContent?.trim() === "Advanced"
  );
  act(() => toggle?.click());
}

const WRITE = { actionType: "web3/write-contract", network: "1" };

describe("Send as field", () => {
  it("shows under Network on a chain with a private relay", async () => {
    await render(WRITE);
    expect(field()?.textContent).toContain("Send as");
    expect(field()?.textContent).toContain("Normal transaction");
    expect(field()?.textContent).toContain(
      "Sent to the public mempool. Can be sponsored."
    );
  });

  it("is hidden when only Normal applies", async () => {
    await render({ ...WRITE, network: "8453" });
    expect(field()).toBeNull();
  });

  it("opens a legacy (Flashbots) config as Private relay with a one-time notice", async () => {
    const legacy = { ...WRITE, usePrivateMempool: true };
    await render(legacy);
    // The closed field shows the short name; the menu has the full one.
    expect(container.querySelector("#sendMode")?.textContent).toBe(
      "Private relay"
    );
    const notice = container.querySelector(
      '[data-testid="send-mode-legacy-notice"]'
    );
    expect(notice?.textContent).toBe(legacyRelayNotice("Ethereum"));
    expect(notice?.textContent).toBe(
      'Ethereum (Flashbots) is now Ethereum with "Send as" set to Private relay. This step sends exactly as before.'
    );
    // The stored config is not rewritten, and showing it does not spend it.
    expect(latest).toEqual(legacy);
    expect(window.localStorage.length).toBe(0);

    // A copy that was never on screen (jsdom lays nothing out) does not spend
    // it either: a second mount, as on phones, still shows it.
    await remount(legacy);
    expect(byTestId("send-mode-legacy-notice")).not.toBeNull();

    // Once a visible notice goes away (panel closed), it is not shown again.
    vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([
      {},
    ] as unknown as DOMRectList);
    await remount(legacy);
    await remount(legacy);
    expect(byTestId("send-mode-legacy-notice")).toBeNull();

    // Another node of the same workflow still gets it once.
    await remount(legacy, { workflow: "wf-1", node: "node-2" });
    expect(byTestId("send-mode-legacy-notice")).not.toBeNull();
  });

  it("is hidden on Batch Write Contract, which has only Normal for now", async () => {
    await render({ ...WRITE, actionType: "web3/batch-write-contract" });
    expect(field()).toBeNull();
  });

  it("keeps a Batch Write Contract saved with the relay, with a notice", async () => {
    const legacy = {
      ...WRITE,
      actionType: "web3/batch-write-contract",
      usePrivateMempool: true,
    };
    await render(legacy);
    expect(container.querySelector("#sendMode")?.textContent).toBe(
      "Private relay"
    );
    expect(
      container.querySelector('[data-testid="send-mode-unsupported-notice"]')
        ?.textContent
    ).toContain(
      "Batch Write Contract can't send through the private relay yet, so this step fails before sending."
    );
    expect(
      container.querySelector('[data-testid="send-mode-legacy-notice"]')
    ).toBeNull();
    expect(latest).toEqual(legacy);

    // One click back to Normal.
    const use = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Use Normal transaction"
    );
    act(() => use?.click());
    expect(latest).toMatchObject({
      sendMode: "transaction",
      usePrivateMempool: false,
    });
  });

  it("waits for the chain before showing (and spending) the one-time notice", async () => {
    setEditorSendModeChains(undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => undefined))
    );
    await render(
      { ...WRITE, usePrivateMempool: true },
      { workflow: "wf-9", node: "n" }
    );
    expect(
      container.querySelector('[data-testid="send-mode-legacy-notice"]')
    ).toBeNull();
    expect(
      window.localStorage.getItem("kh:send-as-legacy-notice:wf-9:n")
    ).toBeNull();
  });

  it("closes the one-time notice for good on Dismiss", async () => {
    await render({ ...WRITE, usePrivateMempool: true });
    const close = container.querySelector<HTMLButtonElement>(
      '[data-testid="send-mode-legacy-notice"] button[aria-label="Dismiss"]'
    );
    act(() => close?.click());
    expect(byTestId("send-mode-legacy-notice")).toBeNull();
    await remount({ ...WRITE, usePrivateMempool: true });
    expect(byTestId("send-mode-legacy-notice")).toBeNull();
  });

  it("keeps a private relay saved on a chain that lost it visible, to change it", async () => {
    await render({ ...WRITE, network: "8453", sendMode: "private-relay" });
    expect(container.querySelector("#sendMode")?.textContent).toBe(
      "Private relay"
    );
  });
});

describe("Sponsor gas and Send as", () => {
  it("turning Sponsor gas on sets Send as to Normal, with Undo", async () => {
    const start = {
      ...WRITE,
      sendMode: "private-relay",
      usePrivateMempool: true,
      sponsorGas: false,
    };
    await render(start);
    openAdvanced();
    const toggle = container.querySelector<HTMLButtonElement>("#sponsorGas");
    act(() => toggle?.click());

    expect(latest).toMatchObject({
      sponsorGas: true,
      sendMode: "transaction",
      usePrivateMempool: false,
    });
    const notice = container.querySelector(
      '[data-testid="sponsor-gas-send-mode-notice"]'
    );
    expect(notice?.textContent).toContain(SPONSOR_ON_NOTICE);

    const undo = [...(notice?.querySelectorAll("button") ?? [])].find(
      (button) => button.textContent === "Undo"
    );
    act(() => undo?.click());
    expect(latest).toMatchObject(start);
    expect(
      container.querySelector('[data-testid="sponsor-gas-send-mode-notice"]')
    ).toBeNull();
  });

  it("shows Sponsor gas off on an old (Flashbots) step, without writing it", async () => {
    const legacy = { ...WRITE, usePrivateMempool: true };
    await render(legacy);
    openAdvanced();
    const toggle = container.querySelector<HTMLButtonElement>("#sponsorGas");
    expect(toggle?.getAttribute("aria-checked")).toBe("false");
    expect(
      container.querySelector('[data-testid="sponsor-gas-send-as-hint"]')
        ?.textContent
    ).toContain("Off because Send as is Private relay");
    expect(latest).toEqual(legacy);

    act(() => toggle?.click());
    expect(latest).toMatchObject({
      sponsorGas: true,
      sendMode: "transaction",
      usePrivateMempool: false,
    });
  });

  it("hides a notice once the keys it wrote change again", async () => {
    await render({
      ...WRITE,
      sendMode: "private-relay",
      usePrivateMempool: true,
      sponsorGas: false,
    });
    openAdvanced();
    const toggle = container.querySelector<HTMLButtonElement>("#sponsorGas");
    act(() => toggle?.click());
    const notice = () =>
      container.querySelector('[data-testid="sponsor-gas-send-mode-notice"]');
    expect(notice()).not.toBeNull();
    // Turning it off again changes what the notice wrote: it goes away.
    act(() => toggle?.click());
    expect(latest).toMatchObject({ sponsorGas: false });
    expect(notice()).toBeNull();
  });

  it("turning Sponsor gas off leaves Send as alone", async () => {
    await render({ ...WRITE, sendMode: "transaction" });
    openAdvanced();
    const toggle = container.querySelector<HTMLButtonElement>("#sponsorGas");
    act(() => toggle?.click());
    expect(latest).toMatchObject({
      sponsorGas: false,
      sendMode: "transaction",
    });
    expect(
      container.querySelector('[data-testid="sponsor-gas-send-mode-notice"]')
    ).toBeNull();
  });
});

describe("old flags and chains without a relay", () => {
  it.each(["false", 1, "yes"])(
    "shows %j on Base as Normal: no field, badge, notice or forced Sponsor gas",
    async (flag) => {
      const legacy = { ...WRITE, network: "8453", usePrivateMempool: flag };
      await render(legacy);
      expect(field()).toBeNull();
      expect(byTestId("send-mode-legacy-notice")).toBeNull();
      expect(byTestId("send-mode-unavailable-notice")).toBeNull();
      openAdvanced();
      const toggle = container.querySelector("#sponsorGas");
      expect(toggle?.getAttribute("aria-checked")).toBe("true");
      expect(byTestId("sponsor-gas-send-as-hint")).toBeNull();
      expect(latest).toEqual(legacy);
    }
  );

  it.each(["false", 1, "yes"])(
    "shows %j on Ethereum as Private relay, as it sends",
    async (flag) => {
      await render({ ...WRITE, usePrivateMempool: flag });
      expect(container.querySelector("#sendMode")?.textContent).toBe(
        "Private relay"
      );
      expect(byTestId("send-mode-legacy-notice")).not.toBeNull();
    }
  );

  it("warns that a real true on Base fails, and fixes it in one click", async () => {
    const legacy = { ...WRITE, network: "8453", usePrivateMempool: true };
    await render(legacy);
    const warning = byTestId("send-mode-unavailable-notice");
    expect(warning?.textContent).toContain(
      "Base has no private relay, so this step fails before sending."
    );
    expect(byTestId("send-mode-legacy-notice")).toBeNull();
    // The field reads the warning out.
    const describedBy = container
      .querySelector("#sendMode")
      ?.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(String(describedBy))?.textContent).toContain(
      "fails before sending"
    );

    act(() => button("Use Normal transaction", warning ?? container)?.click());
    // Sponsor gas showed off and was never set: it stays off.
    expect(latest).toMatchObject({
      sendMode: "transaction",
      usePrivateMempool: false,
      sponsorGas: false,
    });
    await settle();
    expect(field()).toBeNull();
    expect(document.activeElement?.id).toBe("network");
    const status = container.querySelector('[role="status"].sr-only');
    expect(status?.textContent).toBe("Send as set to Normal transaction.");
    expect(status?.getAttribute("aria-atomic")).toBe("false");
  });

  it("says a strict: false step goes public instead", async () => {
    await render({
      ...WRITE,
      network: "8453",
      sendMode: "private-relay",
      strict: false,
    });
    expect(byTestId("send-mode-unavailable-notice")?.textContent).toContain(
      "Base has no private relay, so this step sends to the public mempool."
    );
  });

  it("reads the Batch warning out and focuses Network after the fix", async () => {
    await render({
      ...WRITE,
      actionType: "web3/batch-write-contract",
      usePrivateMempool: true,
    });
    const describedBy = container
      .querySelector("#sendMode")
      ?.getAttribute("aria-describedby");
    expect(document.getElementById(String(describedBy))?.textContent).toContain(
      "Batch Write Contract can't send through the private relay yet"
    );
    act(() => button("Use Normal transaction")?.click());
    // Announced only after focus has moved, so it is not cut off.
    expect(container.textContent).not.toContain(
      "Send as set to Normal transaction."
    );
    await settle();
    expect(document.activeElement?.id).toBe("network");
    expect(container.textContent).toContain(
      "Send as set to Normal transaction."
    );
  });
});

describe("notice focus", () => {
  it("puts focus back on the control Undo restored", async () => {
    await render({
      ...WRITE,
      sendMode: "private-relay",
      usePrivateMempool: true,
      sponsorGas: false,
    });
    openAdvanced();
    act(() =>
      container.querySelector<HTMLButtonElement>("#sponsorGas")?.click()
    );
    const notice = byTestId("sponsor-gas-send-mode-notice");
    act(() => button("Undo", notice ?? container)?.click());
    await settle();
    expect(document.activeElement?.id).toBe("sponsorGas");
  });

  it("focuses Send as after the one-time notice is dismissed", async () => {
    await render({ ...WRITE, usePrivateMempool: true });
    act(() =>
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="send-mode-legacy-notice"] button[aria-label="Dismiss"]'
        )
        ?.click()
    );
    await settle();
    expect(document.activeElement?.id).toBe("sendMode");
  });

  it("does not re-read buttons in the live regions", async () => {
    await render({ ...WRITE, usePrivateMempool: true });
    for (const region of container.querySelectorAll('[role="status"]')) {
      expect(region.getAttribute("aria-atomic")).toBe("false");
    }
  });
});

// The notice slot as every field sees it (Send as, Sponsor gas, Network).
type Api = {
  config: Record<string, unknown>;
  send: ReturnType<typeof useEditorNotice>;
  net: ReturnType<typeof useEditorNotice>;
  set: (next: Record<string, unknown>) => void;
};
const api = {} as Api;

function SlotHarness({ initial }: { initial: Record<string, unknown> }) {
  const [config, setConfig] = useState(initial);
  const update = (key: string, value: unknown) =>
    setConfig((current) => ({ ...current, [key]: value }));
  api.config = config;
  api.send = useEditorNotice("send-mode", config, update, "sendMode");
  api.net = useEditorNotice("network", config, update, "network");
  api.set = (next) => setConfig((current) => ({ ...current, ...next }));
  return null;
}

async function renderSlot(initial: Record<string, unknown>): Promise<void> {
  const store = createStore();
  store.set(selectedNodeAtom, "n1");
  await act(async () => {
    root.render(
      <Provider store={store}>
        <SlotHarness initial={initial} />
      </Provider>
    );
    await Promise.resolve();
  });
}

const ETHEREUM = CHAINS[0];
const BASE = CHAINS[1];

describe("one notice slot, never stale", () => {
  it("a later change without a notice clears it (no stale Undo)", async () => {
    await renderSlot(WRITE);
    act(() => api.send.apply(pickSendMode(api.config, "private-relay")));
    expect(api.send.notice?.text).toContain("Sponsor gas turned off");
    act(() => api.send.apply(pickSendMode(api.config, "transaction")));
    act(() => api.send.apply(pickSendMode(api.config, "private-relay")));
    // Sponsor gas was already off for this pick: no notice, none brought back.
    expect(api.config.sponsorGas).toBe(false);
    expect(api.send.notice).toBeNull();
  });

  it("a later network pick clears the network notice", async () => {
    await renderSlot({
      ...WRITE,
      sendMode: "private-relay",
      usePrivateMempool: true,
    });
    act(() => {
      api.set({ network: "8453" });
      api.net.apply(chooseNetwork(api.config, BASE, "network"));
    });
    expect(api.net.notice?.text).toContain("Base has no private relay");
    act(() => {
      api.set({ network: "1" });
      api.net.apply(
        chooseNetwork({ ...api.config, network: "8453" }, ETHEREUM, "network")
      );
    });
    expect(api.net.notice).toBeNull();
    expect(api.config).toMatchObject({ network: "1", sendMode: "transaction" });
  });

  it("network Undo restores the network, Send as and fees it cleared", async () => {
    await renderSlot({
      ...WRITE,
      sendMode: "private-relay",
      usePrivateMempool: true,
      sponsorGas: false,
      priorityFeeGwei: "3",
    });
    const before = { ...api.config };
    act(() => {
      api.set({ network: "8453" });
      api.net.apply(chooseNetwork(before, BASE, "network"));
    });
    // The reset made the step sponsorable, so the editor clears the fee.
    act(() => api.set({ priorityFeeGwei: undefined }));
    expect(api.net.notice).not.toBeNull();
    act(() => api.net.undo());
    expect(api.config).toMatchObject({
      network: "1",
      sendMode: "private-relay",
      usePrivateMempool: true,
      priorityFeeGwei: "3",
    });
  });
});

describe("canvas badge", () => {
  async function badge(config: Record<string, unknown>) {
    await act(async () => {
      root.render(<SendModeBadge config={{ ...WRITE, ...config }} />);
      await Promise.resolve();
    });
    return {
      marker: byTestId("send-mode-warning-badge"),
      private: byTestId("send-mode-badge"),
    };
  }

  it("marks a step that fails before sending, with no PRIVATE badge", async () => {
    const { marker, private: badgeEl } = await badge({
      network: "8453",
      usePrivateMempool: true,
    });
    expect(badgeEl).toBeNull();
    expect(marker?.textContent).toBe(
      "Send as: Base has no private relay, so this step fails before sending."
    );
    expect(marker?.querySelector("svg")?.getAttribute("aria-hidden")).toBe(
      "true"
    );
  });

  it("marks an old Batch relay step", async () => {
    const { marker } = await badge({
      actionType: "web3/batch-write-contract",
      usePrivateMempool: true,
    });
    expect(marker?.textContent).toContain(
      "Batch Write Contract can't send through the private relay yet"
    );
  });

  it("shows PRIVATE on a relay step and nothing on a strict: false public send", async () => {
    expect((await badge({ sendMode: "private-relay" })).private).not.toBeNull();
    const publicSend = await badge({
      network: "8453",
      sendMode: "private-relay",
      strict: false,
    });
    expect(publicSend.marker).toBeNull();
    expect(publicSend.private).toBeNull();
  });
});
