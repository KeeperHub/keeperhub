// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChainSelectField } from "@/components/workflow/config/chain-select-field";
import type { OrgRpcEditorState } from "@/lib/workflow/editor/rpc-config-options";

const CHAIN = {
  id: "chain_10",
  chainId: 10,
  name: "Optimism",
  symbol: "ETH",
  chainType: "evm",
  isTestnet: false,
  isEnabled: true,
  usePrivateMempoolRpc: false,
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve({ ok: true, json: () => Promise.resolve([CHAIN]) })
    )
  );
  container = document.createElement("div");
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
});

async function renderPrivate(
  rpcState: OrgRpcEditorState | undefined,
  onUpdateConfig: (key: string, value: unknown) => void
): Promise<void> {
  await act(async () => {
    root.render(
      <ChainSelectField
        field={{ key: "network", label: "Network", type: "chain-select" }}
        onChange={() => undefined}
        onUpdateConfig={onUpdateConfig}
        rpcSelection="auto"
        rpcState={rpcState}
        showPrivateVariants
        value="10:private"
      />
    );
    await Promise.resolve();
  });
}

describe("ChainSelectField private entry", () => {
  it("turns the private send off when the RPC selection no longer offers it", async () => {
    const onUpdateConfig = vi.fn();
    await renderPrivate({ configs: [], ownRpcOnlyChains: [] }, onUpdateConfig);

    expect(onUpdateConfig).toHaveBeenCalledWith("usePrivateMempool", false);
  });

  it("leaves it alone until the organization's setup is known", async () => {
    const onUpdateConfig = vi.fn();
    await renderPrivate(undefined, onUpdateConfig);

    expect(onUpdateConfig).not.toHaveBeenCalled();
  });
});
