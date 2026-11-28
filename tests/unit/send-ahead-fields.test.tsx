// @vitest-environment jsdom
import { createStore, Provider } from "jotai";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import "@/lib/workflow/editor/extensions";
import { ActionConfigRenderer } from "@/components/workflow/config/action-config-renderer";
import { formatDateTime } from "@/lib/web3/unix-time-display";
import {
  setEditorBundlesEnabled,
  setEditorSendModeChains,
} from "@/lib/workflow/editor/send-mode-chains";
import { currentWorkflowIdAtom, selectedNodeAtom } from "@/lib/workflow/store";
import { type ActionConfigField, findActionById } from "@/plugins/registry";

const CHAINS = [
  {
    chainId: 1,
    name: "Ethereum",
    symbol: "ETH",
    usePrivateMempoolRpc: true,
    bundleBuilders: ["flashbots", "titan", "quasar"],
    chainType: "evm",
    isTestnet: false,
    isEnabled: true,
  },
];

const BUNDLE = {
  actionType: "web3/write-contract",
  network: "1",
  sendMode: "bundle",
  usePrivateMempool: false,
  sponsorGas: false,
};

const UNLOCK = 1_796_126_400;

let container: HTMLDivElement;
let root: Root;

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
  "simulateAt",
  "simulateTimestampOffsetSec",
  "simulateTime",
]);

function fieldsOf(actionType: string): ActionConfigField[] {
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
  return (
    <ActionConfigRenderer
      config={config}
      fields={fieldsOf(String(initial.actionType))}
      onUpdateConfig={(key, value) =>
        setConfig((current) => ({ ...current, [key]: value }))
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

function boxText(): string {
  return byTestId("bundle-settings")?.textContent ?? "";
}

function setting(key: string): HTMLInputElement | null {
  return container.querySelector<HTMLInputElement>(`[data-setting="${key}"]`);
}

/** The ids an element's aria-describedby names, each resolved to its text. */
function describedBy(element: Element | null | undefined): string[] {
  return (element?.getAttribute("aria-describedby") ?? "")
    .split(" ")
    .filter(Boolean)
    .map((id) => document.getElementById(id)?.textContent ?? `missing ${id}`);
}

function notBeforeBox(): HTMLElement | null {
  return container.querySelector<HTMLElement>("#notBefore");
}

describe("Not before in the bundle box", () => {
  it("is empty by default, with its hints, and Send ahead is hidden", async () => {
    await render(BUNDLE);
    const box = notBeforeBox();
    expect(box?.getAttribute("role")).toBe("textbox");
    expect(box?.getAttribute("aria-invalid")).toBeNull();
    const label = document.getElementById(
      box?.getAttribute("aria-labelledby") ?? ""
    );
    expect(label?.textContent).toBe("Not before");
    expect(describedBy(box)).toEqual([
      "Optional. The bundle never lands in a block before this time. Unix seconds, such as 1796126400, or a date with a time zone, such as 2026-12-01T12:00:00Z. Can be a template, such as {{Read Contract.result}}. Empty: sends for the next blocks.",
      "A run that is too early sends nothing and ends Skipped (Waiting). A waiting run counts toward your plan's runs like any other run.",
    ]);
    expect(setting("sendAheadBlocks")).toBeNull();
    expect(boxText()).toContain(
      "Tries 3 blocks in a row, starting with the next one"
    );
    expect(byTestId("time-field-notBefore-reads-as")).toBeNull();
  });

  it("reads a date with a zone, shows Send ahead and counts from the first allowed block", async () => {
    await render({
      ...BUNDLE,
      notBefore: "2026-12-01T12:00:00Z",
      bundleTipIncreasePercent: "20",
      priorityFeeGwei: "5",
    });
    const readsAs = byTestId("time-field-notBefore-reads-as");
    expect(readsAs?.textContent).toBe(
      `Reads as ${formatDateTime(UNLOCK)} in your time zone (1796126400).`
    );
    // The full date with its zone is in the tooltip.
    expect(readsAs?.getAttribute("title")).toMatch(/2026/);
    expect(describedBy(notBeforeBox())[0]).toBe(readsAs?.textContent);
    expect(notBeforeBox()?.getAttribute("aria-invalid")).toBeNull();

    const ahead = setting("sendAheadBlocks");
    expect(ahead).not.toBeNull();
    expect(ahead?.placeholder).toBe("2");
    expect(describedBy(ahead)).toEqual([
      "0 to 3. Sends up to 2 blocks before the first allowed block, so the builders already hold the bundle when it starts. Each bundle still lands only in its own block, never before Not before.",
      "Send ahead + Target blocks: at most 5 (now 2 + 3).",
    ]);
    expect(boxText()).toContain(
      "Tries 3 blocks in a row, starting with the first block allowed by Not before, then the step ends."
    );
    expect(boxText()).toContain(
      "Tips: 5, 6 and 7.2 gwei, from Priority Fee in Advanced, counted from the first allowed block."
    );
  });

  it("reads unix seconds as they are", async () => {
    await render({ ...BUNDLE, notBefore: "1796126400" });
    expect(byTestId("time-field-notBefore-reads-as")?.textContent).toContain(
      "(1796126400)"
    );
  });

  it("refuses milliseconds, tied to the field", async () => {
    await render({ ...BUNDLE, notBefore: "1796126400000" });
    const box = notBeforeBox();
    expect(box?.getAttribute("aria-invalid")).toBe("true");
    const error = byTestId("time-field-notBefore-error");
    expect(error?.textContent).toBe(
      "This looks like milliseconds. Use seconds: 1796126400."
    );
    expect(error?.className).toContain("text-destructive");
    expect(describedBy(box)[0]).toBe(error?.textContent);
    expect(byTestId("time-field-notBefore-reads-as")).toBeNull();
  });

  it("asks for a zone on a date without one", async () => {
    await render({ ...BUNDLE, notBefore: "2026-12-01 12:00" });
    expect(byTestId("time-field-notBefore-error")?.textContent).toBe(
      "Add a time zone, such as Z for UTC: 2026-12-01T12:00:00Z."
    );
  });

  it("leaves a template to the run, and shows Send ahead for it", async () => {
    await render({
      ...BUNDLE,
      notBefore: "{{@read-1:Read Contract.result}}",
    });
    expect(byTestId("time-field-notBefore-error")).toBeNull();
    expect(byTestId("time-field-notBefore-reads-as")).toBeNull();
    expect(notBeforeBox()?.getAttribute("aria-invalid")).toBeNull();
    expect(setting("sendAheadBlocks")).not.toBeNull();
  });
});

describe("Send ahead", () => {
  it("names both fields when Send ahead + Target blocks is over 5", async () => {
    await render({
      ...BUNDLE,
      notBefore: "1796126400",
      bundleBlocks: "4",
      sendAheadBlocks: "2",
    });
    const error = byTestId("sendAheadBlocks-shared-error");
    expect(error?.textContent).toBe(
      "Send ahead (2) + Target blocks (4) is 6. Together they can be at most 5, so lower one of them."
    );
    const ahead = setting("sendAheadBlocks");
    expect(ahead?.getAttribute("aria-invalid")).toBe("true");
    expect(describedBy(ahead)).toContain(error?.textContent);
    // Target blocks shows its own short line, tied to it.
    const blocks = setting("bundleBlocks");
    const short = byTestId("bundleBlocks-shared-error");
    expect(short?.textContent).toBe("With Send ahead, at most 5 (now 6).");
    expect(short?.className).toContain("text-destructive");
    expect(blocks?.getAttribute("aria-invalid")).toBe("true");
    expect(describedBy(blocks)[0]).toBe(short?.textContent);
    expect(describedBy(setting("sendAheadBlocks"))).toContain(
      "Send ahead + Target blocks: at most 5."
    );
  });

  it("fits at 5, with 0 sending only from the first allowed block", async () => {
    await render({
      ...BUNDLE,
      notBefore: "1796126400",
      bundleBlocks: "5",
      sendAheadBlocks: "0",
    });
    expect(byTestId("sendAheadBlocks-shared-error")).toBeNull();
    expect(byTestId("bundleBlocks-shared-error")).toBeNull();
    expect(setting("bundleBlocks")?.getAttribute("aria-invalid")).toBeNull();
    expect(describedBy(setting("sendAheadBlocks"))[0]).toContain(
      "Sends only once the first allowed block is the next one."
    );
  });

  it("has no sum rule without Not before", async () => {
    await render({ ...BUNDLE, bundleBlocks: "5", sendAheadBlocks: "3" });
    expect(setting("sendAheadBlocks")).toBeNull();
    expect(setting("bundleBlocks")?.getAttribute("aria-invalid")).toBeNull();
  });

  it("stays shown without Not before while it holds a value a save refuses", async () => {
    await render({ ...BUNDLE, sendAheadBlocks: "9" });
    const ahead = setting("sendAheadBlocks");
    expect(ahead?.getAttribute("aria-invalid")).toBe("true");
    expect(describedBy(ahead)[0]).toBe("Use a whole number from 0 to 3.");
  });
});

describe("Read Contract, Simulate at a time", () => {
  const READ = { actionType: "web3/read-contract", network: "1" };

  function openAdvanced(): void {
    const toggle = [...container.querySelectorAll("button")].find(
      (candidate) => candidate.textContent?.trim() === "Advanced"
    );
    act(() => toggle?.click());
  }

  it("shows Time only for At a time", async () => {
    await render({ ...READ, simulateAt: "latest" });
    openAdvanced();
    expect(container.querySelector("#simulateAt")).not.toBeNull();
    expect(container.querySelector("#simulateTime")).toBeNull();
  });

  it("asks for a time while it is empty, with the hint under it", async () => {
    await render({ ...READ, simulateAt: "time" });
    openAdvanced();
    const box = container.querySelector("#simulateTime");
    expect(box?.getAttribute("aria-invalid")).toBe("true");
    expect(describedBy(box)).toEqual([
      "Enter a time, or set Simulate at to Latest block.",
      "Unix seconds, such as 1796126400, or a date with a time zone, such as 2026-12-01T12:00:00Z. Can be a template, such as {{Next work time.result}}. The check runs on the latest state with this time as the block time, and the first block number that cannot be earlier. Transactions sent before then are not seen. A time in the past checks the next block.",
    ]);
    expect(
      document.getElementById(box?.getAttribute("aria-labelledby") ?? "")
        ?.textContent
    ).toBe("Time");
  });

  it("reads a date, and refuses milliseconds", async () => {
    await render({
      ...READ,
      simulateAt: "time",
      simulateTime: "2026-12-01T12:00:00Z",
    });
    openAdvanced();
    expect(byTestId("time-field-simulateTime-reads-as")?.textContent).toBe(
      `Reads as ${formatDateTime(UNLOCK)} in your time zone (1796126400).`
    );
    act(() => root.unmount());
    root = createRoot(container);
    await render({
      ...READ,
      simulateAt: "time",
      simulateTime: "1796126400000",
    });
    openAdvanced();
    expect(byTestId("time-field-simulateTime-error")?.textContent).toBe(
      "This looks like milliseconds. Use seconds: 1796126400."
    );
  });
});
