// @vitest-environment jsdom
import { createStore, Provider } from "jotai";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import "@/lib/workflow/editor/extensions";
import { ActionConfigRenderer } from "@/components/workflow/config/action-config-renderer";
import { SendModeBadge } from "@/components/workflow/nodes/send-mode-badge";
import { invalidateFeatureSnapshot } from "@/hooks/use-features";
import { availableSendModes, SEND_MODE } from "@/lib/web3/send-mode";
import {
  editorChainOf,
  getEditorBundlesEnabled,
  setEditorBundlesEnabled,
  setEditorSendModeChains,
} from "@/lib/workflow/editor/send-mode-chains";
import {
  actionSwitchNotice,
  chooseNetwork,
  pickSendMode,
  sendModeWarning,
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
    bundleBuilders: ["flashbots", "titan", "quasar"],
    ...EVM,
  },
  {
    chainId: 8453,
    name: "Base",
    symbol: "ETH",
    usePrivateMempoolRpc: false,
    bundleBuilders: [],
    ...EVM,
  },
];

const WRITE = { actionType: "web3/write-contract", network: "1" };
const BUNDLE = {
  ...WRITE,
  sendMode: "bundle",
  usePrivateMempool: false,
  sponsorGas: false,
};

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
    vi.fn((url: string) =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve(
            url === "/api/features" ? { bundleSendEnabled: true } : CHAINS
          ),
      })
    )
  );
  setEditorSendModeChains(CHAINS);
  setEditorBundlesEnabled(true);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const KEPT = new Set([
  "network",
  "sendMode",
  "bundleBlocks",
  "bundleTipIncreasePercent",
  "bundleBuilders",
  "sponsorGas",
  "simulateAt",
  "simulateTimestampOffsetSec",
]);

// Network, Send as with its box, and Advanced with Sponsor gas and Simulate at.
function allFields(actionType: string): ActionConfigField[] {
  const out: ActionConfigField[] = [];
  for (const entry of findActionById(actionType)?.configFields ?? []) {
    if (entry.type === "group") {
      out.push({
        ...entry,
        fields: entry.fields.filter((inner) => KEPT.has(inner.key)),
      });
    } else if (KEPT.has(entry.key)) {
      out.push(entry);
    }
  }
  return out;
}

function Harness({ initial }: { initial: Record<string, unknown> }) {
  const [config, setConfig] = useState(initial);
  latest = config;
  return (
    <ActionConfigRenderer
      config={config}
      fields={allFields(String(initial.actionType))}
      onUpdateConfig={(key, value) =>
        setConfig((current) => {
          const next = { ...current };
          if (value === undefined) {
            delete next[key];
          } else {
            next[key] = value;
          }
          return next;
        })
      }
    />
  );
}

async function render(initial: Record<string, unknown>): Promise<void> {
  const store = createStore();
  store.set(currentWorkflowIdAtom, "wf-1");
  store.set(selectedNodeAtom, "node-1");
  await act(async () => {
    root.render(
      <Provider store={store}>
        <Harness initial={initial} />
      </Provider>
    );
    await Promise.resolve();
  });
}

function byTestId(id: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${id}"]`);
}

function openAdvanced(): void {
  const toggle = [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === "Advanced"
  );
  act(() => toggle?.click());
}

describe("Bundle in the Send as menu", () => {
  const offered = (network: string): string[] =>
    availableSendModes(editorChainOf(network)).map((option) => option.value);

  it("is offered on a network with builders for an organization in the rollout", () => {
    expect(offered("1")).toContain(SEND_MODE.BUNDLE);
    expect(offered("8453")).not.toContain(SEND_MODE.BUNDLE);
  });

  it("is not offered outside the rollout, or while it is not known", () => {
    setEditorBundlesEnabled(false);
    expect(offered("1")).not.toContain(SEND_MODE.BUNDLE);
    setEditorBundlesEnabled(undefined);
    expect(offered("1")).not.toContain(SEND_MODE.BUNDLE);
  });

  it("is only on Write Contract", () => {
    for (const action of [
      "web3/transfer-funds",
      "web3/approve-token",
      "web3/batch-write-contract",
    ]) {
      const send = findActionById(action)
        ?.configFields.flatMap((entry) =>
          entry.type === "group" ? entry.fields : [entry]
        )
        .find((entry) => entry.key === "sendMode");
      expect(
        send?.options?.map((option) => option.value),
        action
      ).not.toContain("bundle");
    }
  });
});

describe("picking Bundle", () => {
  it("turns Sponsor gas off with its notice and writes no bundle settings", () => {
    const change = pickSendMode({ ...WRITE, sponsorGas: true }, "bundle");
    // The box shows the defaults as placeholders; the run uses them when unset.
    expect(Object.fromEntries(change.writes)).toEqual({
      sendMode: "bundle",
      usePrivateMempool: false,
      sponsorGas: false,
    });
    expect(change.notice).toBe(
      "Sponsor gas turned off: bundles are paid from your wallet."
    );
    expect(Object.fromEntries(change.undo)).toMatchObject({
      sendMode: undefined,
    });
  });
});

describe("the bundle box", () => {
  it("shows under Send as, and hides Simulate at", async () => {
    await render({ ...BUNDLE, bundleBlocks: "3", simulateAt: "next-block" });
    const box = byTestId("bundle-settings");
    expect(box?.getAttribute("role")).toBe("group");
    expect(box?.textContent).toContain("Target blocks");
    expect(box?.textContent).toContain("Tip increase per block (%)");
    expect(box?.textContent).toContain("All 3 builders, including new ones");
    expect(byTestId("bundle-settings-note")?.textContent).toContain(
      "put a deadline in the calldata"
    );
    openAdvanced();
    expect(container.querySelector("#simulateAt")).toBeNull();
    expect(container.querySelector("#simulateTimestampOffsetSec")).toBeNull();
    expect(container.querySelector("#sponsorGas")).not.toBeNull();
  });

  it("is not drawn for another Send as", async () => {
    await render({ ...WRITE, sendMode: "private-relay" });
    expect(byTestId("bundle-settings")).toBeNull();
    openAdvanced();
    expect(container.querySelector("#simulateAt")).not.toBeNull();
  });

  it("says what out-of-range blocks need, and hides the tips until both are in range", async () => {
    await render({
      ...BUNDLE,
      bundleBlocks: "9",
      bundleTipIncreasePercent: "20",
      priorityFeeGwei: "5",
      maxFeeGwei: "6.5",
    });
    const blocks = container.querySelector<HTMLInputElement>(
      '[data-setting="bundleBlocks"]'
    );
    expect(blocks?.getAttribute("aria-invalid")).toBe("true");
    const text = byTestId("bundle-settings")?.textContent ?? "";
    expect(text).toContain("Use a whole number from 1 to 5.");
    expect(text).not.toContain("Tips:");
    expect(text).not.toContain("Tries");
  });

  it("lists the tips each block gets, capped at a set Max Fee", async () => {
    await render({
      ...BUNDLE,
      bundleBlocks: "3",
      bundleTipIncreasePercent: "20",
      priorityFeeGwei: "5",
      maxFeeGwei: "6.5",
    });
    expect(byTestId("bundle-settings")?.textContent).toContain(
      "Tips: 5, 6 and 6.5 gwei, from Priority Fee in Advanced. Later tips stop at the network's tip limit. The step raises its fee cap to pay them, up to Max Fee, and the wallet must hold Gas Limit x that cap. A tip is paid only up to what the 6.5 gwei Max Fee leaves above the base fee."
    );
  });

  it("picks builders, keeps at least one, and goes back to all", async () => {
    await render(BUNDLE);
    const trigger = byTestId(
      "bundle-settings"
    )?.querySelector<HTMLButtonElement>("button[aria-expanded]");
    expect(trigger?.getAttribute("aria-expanded")).toBe("false");
    await act(async () => {
      trigger?.click();
      await Promise.resolve();
    });
    const list = byTestId("bundle-builders-list");
    expect(list).not.toBeNull();
    const box = (name: string) =>
      [...(list?.querySelectorAll('[role="checkbox"]') ?? [])].find(
        (candidate) => candidate.parentElement?.textContent?.trim() === name
      ) as HTMLButtonElement | undefined;
    // Display names; the stored values stay the ids.
    await act(async () => {
      box("Titan")?.click();
      await Promise.resolve();
    });
    expect(latest.bundleBuilders).toEqual(["flashbots", "quasar"]);
    await act(async () => {
      box("Flashbots")?.click();
      await Promise.resolve();
    });
    expect(latest.bundleBuilders).toEqual(["quasar"]);
    // The last one stays focusable and announced, but cannot be unticked.
    const last = box("Quasar");
    expect(last?.disabled).toBe(false);
    expect(last?.getAttribute("aria-disabled")).toBe("true");
    expect(last?.getAttribute("aria-describedby")).toBeTruthy();
    await act(async () => {
      last?.click();
      await Promise.resolve();
    });
    expect(latest.bundleBuilders).toEqual(["quasar"]);
    expect(byTestId("bundle-builders-list")?.textContent).toContain(
      "At least one of the builders is needed."
    );
    expect(byTestId("bundle-builders-list")?.textContent).toContain(
      "Includes builders the network adds later."
    );
    await act(async () => {
      box("All builders")?.click();
      await Promise.resolve();
    });
    expect(latest.bundleBuilders).toBeUndefined();
  });

  it("flags a picked builder the network does not list", async () => {
    await render({ ...BUNDLE, bundleBuilders: ["titan", "gone"] });
    expect(byTestId("bundle-settings")?.textContent).toContain(
      "Not on this network: gone. Runs skip it; changing these settings is refused until it is removed."
    );
    expect(byTestId("bundle-settings")?.textContent).toContain(
      "2 of 3 builders, not new ones"
    );
  });

  it("does not flag builders while the network's list is not known (a template)", async () => {
    await render({
      ...BUNDLE,
      network: "{{@t:Trigger.chainId}}",
      bundleBuilders: ["titan", "quasar"],
    });
    const text = byTestId("bundle-settings")?.textContent ?? "";
    expect(text).not.toContain("Not on this network");
    expect(byTestId("bundle-builders-unchecked")?.textContent).toBe(
      "The network's builders are checked when the step runs."
    );
    expect(
      byTestId("bundle-settings")?.querySelector(".text-destructive")
    ).toBeNull();
  });
});

describe("the organization's bundle flag", () => {
  function featuresAnswer(enabled: boolean) {
    let answer: (value: unknown) => void = () => undefined;
    const pending = new Promise((resolve) => {
      answer = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) =>
        url === "/api/features"
          ? pending.then(() => ({
              ok: true,
              json: () => Promise.resolve({ bundleSendEnabled: enabled }),
            }))
          : Promise.resolve({ ok: true, json: () => Promise.resolve(CHAINS) })
      )
    );
    return () => answer(undefined);
  }

  it("re-renders Send as when the flag arrives after mount", async () => {
    const arrive = featuresAnswer(false);
    invalidateFeatureSnapshot();
    setEditorBundlesEnabled(undefined);
    await render(BUNDLE);
    expect(container.textContent).not.toContain("Bundles are not turned on");
    await act(async () => {
      arrive();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(container.textContent).toContain(
      "Bundles are not turned on for this organization"
    );
  });

  it("is read again for the new organization after an org switch", async () => {
    setEditorBundlesEnabled(true);
    await render(BUNDLE);
    expect(container.textContent).not.toContain("Bundles are not turned on");
    const arrive = featuresAnswer(false);
    await act(async () => {
      invalidateFeatureSnapshot();
      await Promise.resolve();
    });
    // Unknown meanwhile: neither offered nor warned.
    expect(getEditorBundlesEnabled()).toBeUndefined();
    await act(async () => {
      arrive();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(getEditorBundlesEnabled()).toBe(false);
    expect(container.textContent).toContain(
      "Bundles are not turned on for this organization"
    );
  });
});

describe("warnings and changes around Bundle", () => {
  it("sets Normal with a builders notice on a network without them", () => {
    const base = CHAINS[1];
    const change = chooseNetwork(BUNDLE, base, "network");
    expect(Object.fromEntries(change.writes)).toMatchObject({
      sendMode: "transaction",
    });
    expect(change.notice).toBe(
      "Send as changed to Normal transaction (public mempool): Base has no block builders that take bundles."
    );
  });

  it("keeps Bundle on a network change while the rollout is not known", () => {
    setEditorBundlesEnabled(undefined);
    expect(chooseNetwork(BUNDLE, CHAINS[0], "network").writes).toEqual([]);
  });

  it("warns that a Safe connection or the rollout stops the step", () => {
    expect(
      sendModeWarning({ ...BUNDLE, web3Connection: "safe:s1" })
    ).toMatchObject({ fails: true, unsupported: true });
    setEditorBundlesEnabled(false);
    expect(sendModeWarning(BUNDLE)?.text).toBe(
      "Bundles are not turned on for this organization, so this step fails before sending."
    );
    expect(
      sendModeWarning({ ...BUNDLE, web3Connection: "safe:s1" })?.text
    ).toBe(
      'Send as Bundle cannot send through a Safe or Roles connection yet. Use your wallet (EOA) connection, or set Send as to Normal transaction (sendMode: "transaction").'
    );
    setEditorBundlesEnabled(undefined);
    expect(sendModeWarning(BUNDLE)).toBeUndefined();
  });

  it("says why an action switch set Normal", () => {
    const change = actionSwitchNotice(BUNDLE, {
      ...BUNDLE,
      actionType: "web3/batch-write-contract",
      sendMode: "transaction",
    });
    expect(change?.notice).toBe(
      "Send as changed to Normal transaction (public mempool): only Write Contract can send as a bundle."
    );
  });

  it("shows a BUNDLE badge on the canvas", async () => {
    await act(async () => {
      root.render(<SendModeBadge config={BUNDLE} />);
      await Promise.resolve();
    });
    const badge = byTestId("send-mode-badge");
    expect(badge?.textContent).toContain("BUNDLE");
    expect(badge?.getAttribute("title")).toBe(
      "Send as: Bundle to block builders"
    );
  });
});
