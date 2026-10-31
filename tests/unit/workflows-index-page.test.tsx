// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  replace: vi.fn(),
  push: vi.fn(),
  getAll: vi.fn(),
  params: new URLSearchParams(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mocks.replace, push: mocks.push }),
  useSearchParams: () => mocks.params,
}));
vi.mock("@/lib/api-client", () => ({
  api: { workflow: { getAll: mocks.getAll } },
}));

import WorkflowsIndexPage from "@/app/workflows/page";

let container: HTMLDivElement;
let root: Root;

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.params = new URLSearchParams("latest=edited");
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function renderPage(): Promise<void> {
  await act(async () => {
    root.render(<WorkflowsIndexPage />);
    await Promise.resolve();
  });
}

function workflow(
  id: string,
  createdAt: string,
  updatedAt: string,
  name = id
): { id: string; name: string; createdAt: string; updatedAt: string } {
  return { id, name, createdAt, updatedAt };
}

describe("workflows index", () => {
  it("opens the workflow edited most recently, not the newest", async () => {
    mocks.getAll.mockResolvedValue([
      workflow("newest", "2026-10-10T00:00:00Z", "2026-10-10T00:00:00Z"),
      workflow("edited", "2026-09-01T00:00:00Z", "2026-10-12T00:00:00Z"),
    ]);
    await renderPage();
    expect(mocks.replace).toHaveBeenCalledWith("/workflows/edited");
  });

  it("skips the internal scratch workflow", async () => {
    mocks.getAll.mockResolvedValue([
      workflow(
        "scratch",
        "2026-10-13T00:00:00Z",
        "2026-10-13T00:00:00Z",
        "__current__"
      ),
      workflow("real", "2026-10-01T00:00:00Z", "2026-10-02T00:00:00Z"),
    ]);
    await renderPage();
    expect(mocks.replace).toHaveBeenCalledWith("/workflows/real");
  });

  it("shows the empty state when only the scratch workflow exists", async () => {
    mocks.getAll.mockResolvedValue([
      workflow(
        "scratch",
        "2026-10-13T00:00:00Z",
        "2026-10-13T00:00:00Z",
        "__current__"
      ),
    ]);
    await renderPage();
    expect(mocks.replace).not.toHaveBeenCalled();
    expect(container.textContent).toContain("No workflows yet");
  });

  it("opens the newest workflow without ?latest=edited", async () => {
    mocks.params = new URLSearchParams();
    mocks.getAll.mockResolvedValue([
      workflow("newest", "2026-10-10T00:00:00Z", "2026-10-10T00:00:00Z"),
      workflow("edited", "2026-09-01T00:00:00Z", "2026-10-12T00:00:00Z"),
    ]);
    await renderPage();
    expect(mocks.replace).toHaveBeenCalledWith("/workflows/newest");
  });
});
