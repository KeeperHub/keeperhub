// @vitest-environment jsdom
/**
 * Which toolbar controls a phone gets, per the round-6 review: the per-control
 * gates in `components/workflow/workflow-toolbar.tsx` were pinned by nothing, and
 * the one that matters most for safety is the carve-out that keeps Stop reachable
 * while a run is in flight.
 *
 * The component is rendered for real rather than through a stub, because the gate
 * reads `useEditorAvailability()` inside `ToolbarActions` and `useWorkflowState`
 * is module-private: a stubbed toolbar would test the stub. The providers are the
 * ones the browser harness already mounts it with.
 */

import { ReactFlowProvider } from "@xyflow/react";
import { Provider as JotaiProvider } from "jotai";
import { useHydrateAtoms } from "jotai/utils";
import type React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  usePathname: () => "/workflows/demo",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/lib/auth-client", () => ({
  useSession: () => ({ data: { user: { id: "u1", email: "a@example.com" } } }),
}));

// One array identity, deliberately: the toolbar mirrors these into state from an
// effect keyed on the array, so a fresh `[]` per render loops forever.
const EMPTY_PROJECTS: never[] = [];

vi.mock("@/lib/hooks/use-org-data", () => ({
  useProjects: () => ({ data: EMPTY_PROJECTS }),
  useTags: () => ({ data: EMPTY_PROJECTS }),
}));

vi.mock("@/components/auth/provider", () => ({
  useAuthPrompt: () => vi.fn(),
}));

vi.mock("@/components/organization/org-switcher", () => ({
  OrgSwitcher: () => null,
}));

vi.mock("@/components/navigation/mobile-nav-sheet", () => ({
  MobileNavSheet: () => null,
}));

vi.mock("@/components/workflow/wallet-toolbar-button", () => ({
  WalletToolbarButton: () => null,
}));

vi.mock("server-only", () => ({}));

// The api client is what reaches `@sentry/server-utils`, whose bundler plugin
// throws on import in this environment. Nothing here calls the network.
vi.mock("@/lib/api-client", () => ({
  api: {
    workflow: {
      update: vi.fn().mockResolvedValue({}),
      create: vi.fn().mockResolvedValue({ id: "demo" }),
      delete: vi.fn().mockResolvedValue({}),
      get: vi.fn().mockResolvedValue({}),
      getAll: vi.fn().mockResolvedValue([]),
    },
    user: { get: vi.fn().mockResolvedValue({}) },
  },
  ApiError: class ApiError extends Error {},
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
}));

vi.mock("@/lib/logging", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { OverlayProvider } from "@/components/overlays/overlay-provider";
import { WorkflowToolbar } from "@/components/workflow/workflow-toolbar";
import {
  currentWorkflowIdAtom,
  currentWorkflowNameAtom,
  edgesAtom,
  isExecutingAtom,
  isWorkflowOwnerAtom,
  nodesAtom,
  selectedNodeAtom,
} from "@/lib/workflow/store";

type Viewport = { width: number; coarse?: boolean; userAgent?: string };

const DESKTOP_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";
const PHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";

let viewport: Viewport = { width: 1440 };

function stubViewport(next: Viewport): void {
  viewport = next;
  Object.defineProperty(navigator, "userAgent", {
    configurable: true,
    value: viewport.userAgent ?? DESKTOP_UA,
  });
  window.matchMedia = ((query: string) => ({
    matches: query.includes("pointer: coarse")
      ? Boolean(viewport.coarse)
      : query.includes("max-width: 767px") && viewport.width < 768,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

const mounted: (() => void)[] = [];

function Hydrate({
  children,
  isExecuting,
}: {
  children: React.ReactNode;
  isExecuting: boolean;
}) {
  useHydrateAtoms([
    [isWorkflowOwnerAtom, true],
    [currentWorkflowIdAtom, "demo"],
    [currentWorkflowNameAtom, "Demo workflow"],
    [isExecutingAtom, isExecuting],
    // Selected, so the Delete gate is on screen in both directions.
    [selectedNodeAtom, "t1"],
    [
      nodesAtom,
      [
        {
          id: "t1",
          position: { x: 0, y: 0 },
          data: { type: "trigger", config: { triggerType: "manual" } },
          type: "default",
          selected: true,
        },
      ] as never,
    ],
    [edgesAtom, [] as never],
  ]);
  return <>{children}</>;
}

function mount(isExecuting: boolean): HTMLElement {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <JotaiProvider>
        <Hydrate isExecuting={isExecuting}>
          <OverlayProvider>
            <ReactFlowProvider>
              <WorkflowToolbar persistent />
            </ReactFlowProvider>
          </OverlayProvider>
        </Hydrate>
      </JotaiProvider>
    );
  });
  mounted.push(() => act(() => root.unmount()));
  return container;
}

/** The controls, by the icon each one renders, which is stable across copy. */
function controls(container: HTMLElement) {
  return {
    run: container.querySelector('[data-tour="workflow-run"]') !== null,
    stop: container.querySelector('[title="Stop Execution"]') !== null,
    save: container.querySelector("svg.lucide-save") !== null,
    download: container.querySelector("svg.lucide-download") !== null,
    configure: container.querySelector("svg.lucide-settings-2") !== null,
    remove: container.querySelector("svg.lucide-trash-2") !== null,
    listing: container.querySelector("svg.lucide-store") !== null,
  };
}

beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = "";
  stubViewport({ width: 1440 });
});

afterEach(() => {
  for (const unmount of mounted.splice(0)) {
    unmount();
  }
  vi.restoreAllMocks();
});

describe("the toolbar on a phone", () => {
  it("offers no authoring controls and no way to start a run", () => {
    stubViewport({ width: 390, coarse: true, userAgent: PHONE_UA });
    const seen = controls(mount(false));

    console.log("phone:", JSON.stringify(seen));
    expect(seen.run).toBe(false);
    expect(seen.save).toBe(false);
    expect(seen.configure).toBe(false);
    expect(seen.listing).toBe(false);
    expect(seen.remove).toBe(false);
    // Read-only, and how someone on a phone takes a workflow away with them.
    expect(seen.download).toBe(true);
  });

  it("withholds Run in landscape too, where the width is desktop-like", () => {
    // The round-6 finding: at 932px a phone reports a desktop-shaped width, so a
    // gate with a width term gave it a live Run button.
    stubViewport({ width: 932, coarse: true, userAgent: PHONE_UA });
    const seen = controls(mount(false));

    console.log("phone-landscape:", JSON.stringify(seen));
    expect(seen.run).toBe(false);
    expect(seen.save).toBe(false);
    expect(seen.download).toBe(true);
  });

  it("keeps Stop reachable while a run is in flight", () => {
    stubViewport({ width: 390, coarse: true, userAgent: PHONE_UA });
    const seen = controls(mount(true));

    console.log("phone-executing:", JSON.stringify(seen));
    // The carve-out: a run started on a desktop must be stoppable from the phone
    // that is watching it, even though Run is withheld there.
    expect(seen.stop).toBe(true);
    expect(seen.run).toBe(false);
    expect(seen.save).toBe(false);
  });
});

describe("the toolbar on a desktop", () => {
  it("offers the authoring controls and Run", () => {
    stubViewport({ width: 1440 });
    const seen = controls(mount(false));

    console.log("desktop:", JSON.stringify(seen));
    expect(seen.run).toBe(true);
    expect(seen.save).toBe(true);
    expect(seen.download).toBe(true);
    expect(seen.configure).toBe(true);
    expect(seen.remove).toBe(true);
  });

  it("keeps the editor for a narrow desktop window", () => {
    stubViewport({ width: 700 });
    const seen = controls(mount(false));

    console.log("narrow-desktop:", JSON.stringify(seen));
    expect(seen.run).toBe(true);
    expect(seen.save).toBe(true);
    expect(seen.download).toBe(true);
  });
});
