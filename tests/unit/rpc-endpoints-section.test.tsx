// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RpcEndpointsState } from "@/components/settings/hub/hooks/use-rpc-endpoints";
import { RpcConfigUrlSlot } from "@/lib/rpc/engine/org/url-slots";
import { RpcRouteErrorCode } from "@/lib/rpc/engine/route-error";
import { RpcChainType, RpcPurpose } from "@/lib/rpc/engine/types";

const CHECKED_AT = "2026-01-01T00:00:00.000Z";

const mocks = vi.hoisted(() => ({ isAdmin: true }));

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("@/components/settings/hub/settings-context", () => ({
  useSettingsContext: () => ({
    isAdmin: mocks.isAdmin,
    roleLoading: false,
  }),
}));

const state: RpcEndpointsState = {
  data: {
    chains: [
      {
        chainId: 1,
        name: "Ethereum",
        chainType: RpcChainType.EVM,
        isTestnet: false,
      },
    ],
    configs: [
      {
        id: "cfg-default",
        chainId: 1,
        name: "Primary provider",
        isDefault: true,
        enabled: true,
        slots: [RpcConfigUrlSlot.HTTP_PRIMARY],
        unreadable: false,
        verification: {
          [RpcConfigUrlSlot.HTTP_PRIMARY]: { ok: true, checkedAt: CHECKED_AT },
        },
        createdAt: CHECKED_AT,
        updatedAt: CHECKED_AT,
      },
      {
        id: "cfg-backup",
        chainId: 1,
        name: "Backup provider",
        isDefault: false,
        enabled: false,
        slots: [RpcConfigUrlSlot.HTTP_PRIMARY],
        unreadable: false,
        verification: {
          [RpcConfigUrlSlot.HTTP_PRIMARY]: {
            ok: false,
            checkedAt: CHECKED_AT,
            error: "The endpoint did not answer.",
          },
        },
        createdAt: CHECKED_AT,
        updatedAt: CHECKED_AT,
      },
    ],
    policy: {
      chains: [
        {
          chainId: 1,
          ownRpcOnly: false,
          gaps: [
            {
              workflowId: "wf-1",
              workflowName: "Treasury sweep",
              nodeId: "node-1",
              nodeLabel: "Transfer",
              chainId: 1,
              purpose: RpcPurpose.WRITE,
              code: RpcRouteErrorCode.NO_PRIVATE_URL,
              message: "No private transaction URL.",
            },
          ],
        },
      ],
    },
  },
  loading: false,
  failed: false,
  refetch: vi.fn(async () => undefined),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  test: vi.fn(),
  setOwnRpcOnly: vi.fn(),
};

vi.mock("@/components/settings/hub/hooks/use-rpc-endpoints", () => ({
  useRpcEndpoints: () => state,
}));

import { RpcEndpointsSection } from "@/components/settings/hub/rpc-endpoints-section";
import { TooltipProvider } from "@/components/ui/tooltip";

let container: HTMLDivElement;
let root: Root;

function render(): void {
  act(() =>
    root.render(
      <TooltipProvider>
        <RpcEndpointsSection />
      </TooltipProvider>
    )
  );
}

function buttonLabels(): string[] {
  return [...container.querySelectorAll("button")].map(
    (button) =>
      button.getAttribute("aria-label") ?? button.textContent?.trim() ?? ""
  );
}

beforeEach(() => {
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
});

function expandChain(): void {
  const trigger = container.querySelector<HTMLButtonElement>(
    '[data-testid="rpc-chain-row"] button'
  );
  act(() => trigger?.click());
}

describe("RPC endpoints section", () => {
  it("shows each chain as a collapsed summary", () => {
    mocks.isAdmin = true;
    render();
    const text = container.textContent ?? "";

    expect(text).toContain("Ethereum");
    expect(text).toContain("EVM");
    expect(text).toContain("Default: Primary provider");
    expect(text).toContain("2 endpoints");
    expect(text).toContain("1 failed check");
    expect(
      container.querySelectorAll('[data-testid="rpc-config-row"]')
    ).toHaveLength(0);
  });

  it("opens a chain to show its endpoints, slots and coverage gaps", () => {
    mocks.isAdmin = true;
    render();
    expandChain();

    expect(
      container.querySelectorAll('[data-testid="rpc-config-row"]')
    ).toHaveLength(2);
    expect(
      container.querySelectorAll('[data-slot-name="httpPrimary"]')
    ).toHaveLength(2);
    expect(
      container.querySelector('a[href="/workflows/wf-1"]')?.textContent
    ).toContain("Treasury sweep");
  });

  it("gives owners and admins the write controls", () => {
    mocks.isAdmin = true;
    render();
    expandChain();
    const labels = buttonLabels();

    expect(labels).toContain("Add endpoint");
    expect(labels.filter((l) => l.startsWith("Actions for "))).toHaveLength(2);
    expect(labels.filter((l) => l.startsWith("Enable "))).toHaveLength(2);
    const ownOnly = container.querySelector(
      '[aria-label="Your endpoints only on Ethereum"]'
    );
    expect(ownOnly).not.toBeNull();
    // Turning it on waits for the listed nodes to be covered.
    expect(ownOnly?.hasAttribute("disabled")).toBe(true);
  });

  it("asks before disabling the default, saying Auto steps move to KeeperHub", () => {
    mocks.isAdmin = true;
    vi.mocked(state.update).mockClear();
    render();
    expandChain();
    const toggle = container.querySelector<HTMLButtonElement>(
      '[aria-label="Enable Primary provider"]'
    );
    act(() => toggle?.click());

    const prompt = document.querySelector('[role="alertdialog"]');
    expect(prompt?.textContent).toContain(
      "Disable Primary provider, the Ethereum default?"
    );
    expect(prompt?.textContent).toContain(
      "will run on KeeperHub's endpoints instead"
    );
    expect(state.update).not.toHaveBeenCalled();
  });

  it("is read only for members and viewers", () => {
    mocks.isAdmin = false;
    render();
    expandChain();
    const labels = buttonLabels();

    expect(labels).not.toContain("Add endpoint");
    expect(labels.some((l) => l.startsWith("Actions for "))).toBe(false);
    expect(container.querySelector('[role="switch"]')).toBeNull();
    expect(container.textContent).toContain(
      "Only owners and admins can change them."
    );
    expect(container.textContent).toContain("Backup provider");
  });

  it("filters chains by search", () => {
    mocks.isAdmin = true;
    render();
    const search = container.querySelector<HTMLInputElement>(
      'input[aria-label="Search chains and endpoints"]'
    );
    const setValue = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value"
    )?.set;
    act(() => {
      setValue?.call(search, "polygon");
      search?.dispatchEvent(new Event("input", { bubbles: true }));
    });

    expect(
      container.querySelectorAll('[data-testid="rpc-chain-row"]')
    ).toHaveLength(0);
    expect(container.textContent).toContain(
      "No chain matches this search and filter."
    );
  });
});
