// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/components/overlays/overlay-provider", () => ({
  useOverlay: () => ({ push: vi.fn() }),
}));
vi.mock("@/hooks/use-features", () => ({
  useFeatures: () => ({ snapshot: null }),
}));
vi.mock("@/components/workflow/config/web3-connection-select", () => ({
  Web3ConnectionSelect: ({ safesAllowed }: { safesAllowed?: boolean }) => (
    <div
      data-safes={String(safesAllowed ?? true)}
      data-testid="web3-connection-picker"
    />
  ),
}));
vi.mock("@/components/workflow/config/action-config-renderer", () => ({
  ActionConfigRenderer: () => null,
}));

import { ActionConfig } from "@/components/workflow/config/action-config";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({ json: () => Promise.resolve({}) })
  );
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function stubUser(user: Record<string, unknown>): void {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({ json: () => Promise.resolve(user) })
  );
}

async function renderStep(
  actionType: string,
  extra: Record<string, unknown> = {}
): Promise<void> {
  await act(async () => {
    root.render(
      <ActionConfig
        config={{ actionType, web3Connection: "safe:s1", ...extra }}
        disabled={false}
        onUpdateConfig={vi.fn()}
      />
    );
  });
  // Let the /api/user fetch, its json() and the state update all settle.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function picker(): Element | null {
  return container.querySelector('[data-testid="web3-connection-picker"]');
}

async function showsPicker(actionType: string): Promise<boolean> {
  await renderStep(actionType);
  return picker() !== null;
}

describe("Web3 Connection picker", () => {
  it.each([
    "web3/write-contract",
    "web3/batch-write-contract",
    "web3/approve-token",
    "web3/transfer-funds",
    "web3/transfer-token",
    "robinhood/trade-stock-token",
    "Write Contract",
    "Transfer Funds",
  ])("shows on %s, which sends from the picked wallet", async (actionType) => {
    expect(await showsPicker(actionType)).toBe(true);
  });

  it.each([
    "aave-v3/supply",
    "lido/wrap",
    "uniswap/swap-exact-input",
    "web3/sign-typed-data",
    "web3/transfer-spl-token",
    "web3/send-raw-solana-instruction",
    "web3/call-solana-program-anchor",
  ])("is hidden on %s, which never reads it", async (actionType) => {
    expect(await showsPicker(actionType)).toBe(false);
  });

  it("offers no Safe on Batch Write Contract, which sends from the EOA only", async () => {
    await renderStep("web3/batch-write-contract");
    expect(picker()?.getAttribute("data-safes")).toBe("false");
    await renderStep("web3/write-contract");
    expect(picker()?.getAttribute("data-safes")).toBe("true");
  });

  it.each([
    [
      "aave-v3/supply",
      "1",
      "Sent from your Default Sender (organization policy)",
    ],
    ["web3/sign-typed-data", "1", "Signed by your organization's EOA"],
    [
      "web3/transfer-spl-token",
      "101",
      "Sent from your organization's Solana wallet",
    ],
    [
      "web3/transfer-funds",
      "101",
      "Sent from your organization's Solana wallet",
    ],
  ])("says who sends on %s instead", async (actionType, network, note) => {
    await renderStep(actionType, { network });
    expect(picker()).toBeNull();
    expect(container.textContent).toContain(note);
  });

  it("keeps the sign-in prompt for a signed-out viewer of a hidden picker", async () => {
    stubUser({ isAnonymous: true });
    await renderStep("aave-v3/supply", { network: "1" });
    expect(picker()).toBeNull();
    expect(container.textContent).toContain(
      "Please sign in to add a connection."
    );
    expect(container.textContent).not.toContain("Default Sender");
  });
});
