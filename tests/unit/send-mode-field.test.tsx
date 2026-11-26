// @vitest-environment jsdom
import { createStore, Provider, useAtomValue } from "jotai";
import { act, useEffect, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import "@/lib/workflow/editor/extensions";
import { ActionConfigRenderer } from "@/components/workflow/config/action-config-renderer";
import {
  useActionSwitchNotice,
  useEditorNotice,
} from "@/components/workflow/config/send-mode-field";
import { SendModeBadge } from "@/components/workflow/nodes/send-mode-badge";
import {
  applyConfigUpdate,
  type ConfigUpdateBatch,
  editorConfigValue,
} from "@/lib/workflow/editor/config-update";
import { setEditorSendModeChains } from "@/lib/workflow/editor/send-mode-chains";
import {
  chooseNetwork,
  pickSendMode,
} from "@/lib/workflow/editor/send-mode-editor";
import {
  currentWorkflowIdAtom,
  nodesAtom,
  selectedNodeAtom,
  updateNodeDataAtom,
  type WorkflowNode,
} from "@/lib/workflow/store";
import { type ActionConfigField, findActionById } from "@/plugins/registry";

const SPONSOR_ON_NOTICE =
  "Send as changed to Normal transaction (public mempool): only normal sends can be sponsored.";
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

let harnessWrite: (key: string, value: unknown) => void = () => undefined;

// Writes as the editor does: the plugin adapter's coercion, then one same-tick batch.
function Harness({
  initial,
  disabled,
}: {
  initial: Record<string, unknown>;
  disabled?: boolean;
}) {
  const [config, setConfig] = useState(initial);
  const batch = useRef<ConfigUpdateBatch | null>(null);
  latest = config;
  const fields = relevantFields(String(initial.actionType));
  const write = (key: string, value: unknown): void =>
    setConfig((current) => {
      const next = applyConfigUpdate(
        batch.current,
        current,
        key,
        editorConfigValue(value)
      );
      batch.current = next.batch;
      queueMicrotask(() => {
        batch.current = null;
      });
      return next.config;
    });
  harnessWrite = write;
  return (
    <ActionConfigRenderer
      config={config}
      disabled={disabled}
      fields={fields}
      onUpdateConfig={write}
    />
  );
}

async function render(
  initial: Record<string, unknown>,
  ids = { workflow: "wf-1", node: "node-1" },
  disabled?: boolean
): Promise<void> {
  const store = createStore();
  store.set(currentWorkflowIdAtom, ids.workflow);
  store.set(selectedNodeAtom, ids.node);
  await act(async () => {
    root.render(
      <Provider store={store}>
        <Harness disabled={disabled} initial={initial} />
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

// Focus and the announcement follow the change by a tick or two.
async function settle(check: () => void): Promise<void> {
  await vi.waitFor(async () => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    check();
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
      'saved with the old "(Flashbots)" network, so it still sends through the private relay. Batch Write Contract checks its calls with eth_call, which a relay such as Flashbots Protect refuses, so on such a relay it fails before sending.'
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

  it("does not say it sends as before once the network changed", async () => {
    await render({ ...WRITE, network: "8453", usePrivateMempool: true });
    expect(byTestId("send-mode-legacy-notice")).toBeNull();
    act(() => harnessWrite("network", "1"));
    expect(byTestId("send-mode-legacy-notice")?.textContent).toBe(
      'Ethereum (Flashbots) is now Ethereum with "Send as" set to Private relay.'
    );
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

  it("Reset on a Private relay step clears Sponsor gas and keeps Private relay", async () => {
    const start = {
      ...WRITE,
      sendMode: "private-relay",
      usePrivateMempool: true,
      sponsorGas: "yes",
    };
    // Advanced opens by itself: it holds a value to fix.
    await render(start);
    // A stray value shows Reset, not the "Off because" line.
    expect(byTestId("sponsor-gas-send-as-hint")).toBeNull();
    const reset = [...container.querySelectorAll("button")].find((candidate) =>
      candidate.textContent?.startsWith("Reset to default")
    );
    expect(reset?.textContent).toContain("Reset to default (off)");
    act(() => reset?.click());
    expect(latest).toEqual({ ...start, sponsorGas: undefined });
    expect(container.querySelector("#sendMode")?.textContent).toBe(
      "Private relay"
    );
    expect(byTestId("sponsor-gas-send-mode-notice")).toBeNull();
    expect(
      container.querySelector("#sponsorGas")?.getAttribute("aria-checked")
    ).toBe("false");
    expect(byTestId("sponsor-gas-send-as-hint")?.textContent).toContain(
      "Off because Send as is Private relay"
    );
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
  it.each([true, "false", 1, "yes"])(
    "says %j on Base sends publicly, unsponsored as before, with a one-click Normal",
    async (flag) => {
      const legacy = { ...WRITE, network: "8453", usePrivateMempool: flag };
      await render(legacy);
      const notice = byTestId("send-mode-unavailable-notice");
      expect(notice?.textContent).toContain(
        "Base has no private relay, so this step sends to the public mempool."
      );
      // Neutral, not the failing warning.
      expect(notice?.className).toContain("bg-muted/50");
      expect(byTestId("send-mode-legacy-notice")).toBeNull();
      openAdvanced();
      const toggle = container.querySelector("#sponsorGas");
      expect(toggle?.getAttribute("aria-checked")).toBe("false");
      expect(byTestId("sponsor-gas-send-as-hint")).not.toBeNull();
      expect(latest).toEqual(legacy);

      act(() => button("Use Normal transaction", notice ?? container)?.click());
      expect(latest).toMatchObject({
        sendMode: "transaction",
        usePrivateMempool: false,
      });
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

  it("warns that Private relay on Base fails, and fixes it in one click", async () => {
    const legacy = {
      ...WRITE,
      network: "8453",
      sendMode: "private-relay",
      usePrivateMempool: true,
    };
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
    const status = (): Element | null =>
      container.querySelector('[role="status"].sr-only');
    await settle(() =>
      expect(status()?.textContent).toBe("Send as set to Normal transaction.")
    );
    expect(field()).toBeNull();
    expect(document.activeElement?.id).toBe("network");
    expect(status()?.getAttribute("aria-atomic")).toBe("false");
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
      "Batch Write Contract checks its calls with eth_call"
    );
    act(() => button("Use Normal transaction")?.click());
    // Announced only after focus has moved, so it is not cut off.
    expect(container.textContent).not.toContain(
      "Send as set to Normal transaction."
    );
    await settle(() =>
      expect(container.textContent).toContain(
        "Send as set to Normal transaction."
      )
    );
    expect(document.activeElement?.id).toBe("network");
  });
});

describe("Send as keys to fix", () => {
  it("says so plainly and keeps the shown mode in one click", async () => {
    await render({
      ...WRITE,
      sendMode: "private-relay",
      usePrivateMempool: false,
    });
    const notice = byTestId("send-mode-unavailable-notice");
    expect(notice?.textContent).toContain(
      "This step's saved Send as settings disagree. It runs as Private relay; saving keeps them as they are, but a new network or action needs the fix first. Pick Use Normal transaction or Keep Private relay to fix it."
    );
    expect(notice?.className).toContain("bg-destructive/5");
    expect(button("Use Normal transaction", notice ?? container)).toBeDefined();

    act(() => button("Keep Private relay", notice ?? container)?.click());
    expect(latest).toMatchObject({
      sendMode: "private-relay",
      usePrivateMempool: true,
    });
    expect(byTestId("send-mode-unavailable-notice")).toBeNull();
    await settle(() => expect(document.activeElement?.id).toBe("sendMode"));
  });

  it("says a stray Sponsor gas value stays off on a private relay step", async () => {
    await render({
      ...WRITE,
      sendMode: "private-relay",
      usePrivateMempool: true,
      sponsorGas: "yes",
    });
    // A group holding a stray value opens by itself.
    const hint = container.querySelector("#sponsorGas-stray");
    expect(hint?.textContent).toContain(
      "When the step runs, it is off with these settings."
    );
    expect(hint?.textContent).not.toContain("it is on unless");
    // The switch draws what the text says: off.
    expect(
      container.querySelector("#sponsorGas")?.getAttribute("aria-checked")
    ).toBe("false");
  });

  it("draws a stray Sponsor gas value on a Normal step by its rule", async () => {
    await render({ ...WRITE, sendMode: "transaction", sponsorGas: "yes" });
    expect(container.querySelector("#sponsorGas-stray")?.textContent).toContain(
      "it is on unless"
    );
    expect(
      container.querySelector("#sponsorGas")?.getAttribute("aria-checked")
    ).toBe("true");
  });

  it("does not offer to keep a mode this network does not offer", async () => {
    await render({
      ...WRITE,
      network: "8453",
      sendMode: "private-relay",
      usePrivateMempool: false,
    });
    const notice = byTestId("send-mode-unavailable-notice");
    expect(notice?.textContent).toContain(
      "Base has no private relay, so this step fails before sending. Pick Use Normal transaction to fix it."
    );
    expect(button("Use Normal transaction", notice ?? container)).toBeDefined();
    expect(button("Keep Private relay", notice ?? container)).toBeUndefined();
  });

  it("offers only Normal when the shown mode is Normal, and keeps focus on Send as", async () => {
    await render({ ...WRITE, sendMode: "Private-Relay" });
    const notice = byTestId("send-mode-unavailable-notice");
    expect(notice?.textContent).toContain(
      "This step's saved Send as value is not a known choice, so the step fails before sending."
    );
    expect(
      button("Keep Normal transaction", notice ?? container)
    ).toBeUndefined();
    act(() => button("Use Normal transaction", notice ?? container)?.click());
    expect(latest).toMatchObject({
      sendMode: "transaction",
      usePrivateMempool: false,
    });
    // Ethereum offers Private relay, so the field stays and keeps focus.
    await settle(() => expect(document.activeElement?.id).toBe("sendMode"));
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
    await settle(() => expect(document.activeElement?.id).toBe("sponsorGas"));
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
    await settle(() => expect(document.activeElement?.id).toBe("sendMode"));
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

function SlotHarness({
  initial,
  coerce = (value: unknown): unknown => value,
}: {
  initial: Record<string, unknown>;
  coerce?: (value: unknown) => unknown;
}) {
  const [config, setConfig] = useState(initial);
  const update = (key: string, value: unknown) =>
    setConfig((current) => ({ ...current, [key]: coerce(value) }));
  api.config = config;
  api.send = useEditorNotice("send-mode", config, update, "sendMode");
  api.net = useEditorNotice("network", config, update, "network");
  api.set = (next) => setConfig((current) => ({ ...current, ...next }));
  return null;
}

async function renderSlot(
  initial: Record<string, unknown>,
  coerce?: (value: unknown) => unknown
): Promise<void> {
  const store = createStore();
  store.set(selectedNodeAtom, "n1");
  await act(async () => {
    root.render(
      <Provider store={store}>
        <SlotHarness coerce={coerce} initial={initial} />
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
      sendMode: "private-relay",
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
    // Ethereum has a relay, so the old flag on Batch runs its eth_call check there.
    expect(marker?.textContent).toContain(
      'saved with the old "(Flashbots)" network, so it still sends through the private relay. Batch Write Contract checks its calls with eth_call, which a relay such as Flashbots Protect refuses, so on such a relay it fails before sending.'
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
    // The old flag alone on Base sends publicly: neither marker nor badge.
    const oldFlag = await badge({ network: "8453", usePrivateMempool: true });
    expect(oldFlag.marker).toBeNull();
    expect(oldFlag.private).toBeNull();
  });
});

describe("read-only and failure states", () => {
  it("shows a viewer the notices without their actions", async () => {
    await render(
      { ...WRITE, network: "8453", sendMode: "private-relay" },
      { workflow: "wf-1", node: "node-1" },
      true
    );
    const warning = byTestId("send-mode-unavailable-notice");
    expect(warning?.textContent).toContain("fails before sending");
    expect(warning?.querySelector("button")).toBeNull();
    expect(button("Use Normal transaction")).toBeUndefined();
  });

  it("Undo writes null and numbers back through the editor's adapter without making strings", async () => {
    for (const stored of [
      { usePrivateMempool: null, sponsorGas: null },
      { usePrivateMempool: 0, sponsorGas: 1 },
    ]) {
      act(() => root.unmount());
      root = createRoot(container);
      await renderSlot({ ...WRITE, ...stored }, editorConfigValue);
      act(() => api.send.apply(pickSendMode(api.config, "private-relay")));
      expect(api.send.notice?.text).toContain("Sponsor gas turned off");
      act(() => api.send.undo());
      expect(api.config.usePrivateMempool).not.toBe("null");
      expect(api.config.usePrivateMempool).not.toBe("0");
      expect(api.config.sponsorGas).not.toBe("null");
      expect(api.config.sponsorGas).not.toBe("1");
      // Normal again, as before the pick.
      expect(api.config.sendMode).toBeUndefined();
      expect(Boolean(api.config.usePrivateMempool)).toBe(false);
    }
  });

  let editSwitched: (key: string, value: unknown) => void = () => undefined;
  let pickIntegration: () => void = () => undefined;

  // The editor's node store, with the shared hook the panel and overlay call.
  async function renderSwitch(
    before: Record<string, unknown>,
    after: Record<string, unknown>
  ): Promise<void> {
    const store = createStore();
    store.set(selectedNodeAtom, "node-1");
    store.set(nodesAtom, [
      {
        id: "node-1",
        position: { x: 0, y: 0 },
        data: { label: "Step", type: "action", config: after },
      } as WorkflowNode,
    ]);
    const write = (key: string, value: unknown): void => {
      const config = store.get(nodesAtom)[0]?.data.config ?? {};
      store.set(updateNodeDataAtom, {
        id: "node-1",
        data: { config: { ...config, [key]: editorConfigValue(value) } },
      });
    };
    function Switcher() {
      const config = useAtomValue(nodesAtom)[0]?.data.config ?? {};
      latest = config;
      const note = useActionSwitchNotice();
      editSwitched = write;
      pickIntegration = () => {
        write("integrationId", "picked");
        note({
          nodeId: "node-1",
          key: "integrationId",
          before: after,
          after: { ...after, integrationId: "picked" },
        });
      };
      useEffect(() => {
        note({ nodeId: "node-1", key: "actionType", before, after });
      }, [note]);
      return (
        <ActionConfigRenderer
          config={config}
          fields={relevantFields(String(config.actionType))}
          onUpdateConfig={write}
        />
      );
    }
    await act(async () => {
      root.render(
        <Provider store={store}>
          <Switcher />
        </Provider>
      );
      await Promise.resolve();
    });
  }

  const RELAY_WRITE = {
    ...WRITE,
    sendMode: "private-relay",
    usePrivateMempool: true,
    contractAddress: "0xabc",
  };
  const BATCH = {
    actionType: "web3/batch-write-contract",
    network: "1",
    sendMode: "transaction",
    usePrivateMempool: false,
  };

  it("shows the action switch notice under Network; Undo puts back the whole step", async () => {
    await renderSwitch(RELAY_WRITE, BATCH);
    const notice = byTestId("network-send-mode-notice");
    expect(notice?.textContent).toContain(
      "Batch Write Contract can't send through the private relay yet."
    );
    act(() => button("Undo", notice ?? container)?.click());
    expect(latest).toEqual(RELAY_WRITE);
    expect(byTestId("network-send-mode-notice")).toBeNull();
    await settle(() => expect(document.activeElement?.id).toBe("network"));
  });

  it("closes the action switch notice, and drops it once the new step is edited", async () => {
    await renderSwitch(RELAY_WRITE, BATCH);
    const notice = byTestId("network-send-mode-notice");
    const dismiss = notice?.querySelector<HTMLButtonElement>(
      'button[aria-label="Dismiss"]'
    );
    act(() => dismiss?.click());
    expect(byTestId("network-send-mode-notice")).toBeNull();
    expect(latest).toEqual(BATCH);
    // The close button went with the notice; focus is on Network.
    await settle(() => expect(document.activeElement?.id).toBe("network"));

    act(() => root.unmount());
    root = createRoot(container);
    await renderSwitch(RELAY_WRITE, BATCH);
    expect(byTestId("network-send-mode-notice")).not.toBeNull();
    // A form fill (an empty list) keeps it.
    act(() => editSwitched("calls", "[]"));
    expect(byTestId("network-send-mode-notice")).not.toBeNull();
    // An edit on the new step: Undo would lose it, so the notice goes.
    act(() => editSwitched("calls", '[{"contractAddress":"0x1"}]'));
    expect(byTestId("network-send-mode-notice")).toBeNull();
  });

  it("drops the action switch notice on a manual integration pick", async () => {
    await renderSwitch(RELAY_WRITE, BATCH);
    expect(byTestId("network-send-mode-notice")).not.toBeNull();
    act(() => pickIntegration());
    expect(byTestId("network-send-mode-notice")).toBeNull();
    expect(latest.integrationId).toBe("picked");
  });
});
