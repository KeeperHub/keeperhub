// @vitest-environment jsdom
import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

type Module = typeof import("@/lib/refetch-sidebar");
let refetch: Module;

// The queued refetch is module state, so each test gets a fresh module.
beforeEach(async () => {
  vi.resetModules();
  refetch = await import("@/lib/refetch-sidebar");
});

function Registrant({
  onRefetch,
  children,
}: {
  onRefetch: (options?: unknown) => void;
  children?: React.ReactNode;
}): React.ReactNode {
  useEffect(() => refetch.registerSidebarRefetch(onRefetch), [onRefetch]);
  return children;
}

describe("a refetch made with nothing registered", () => {
  it("reaches a parent and its child that register in one commit", () => {
    const parent = vi.fn();
    const child = vi.fn();
    refetch.refetchSidebar({ orgChanged: true });

    const root = createRoot(document.createElement("div"));
    act(() =>
      root.render(
        <Registrant onRefetch={parent}>
          <Registrant onRefetch={child} />
        </Registrant>
      )
    );

    // The child's effect runs first; the parent must not miss the replay.
    expect(child).toHaveBeenCalledWith({ orgChanged: true });
    expect(parent).toHaveBeenCalledWith({ orgChanged: true });
    act(() => root.unmount());
  });

  it("is not replayed again to a later registrant", async () => {
    refetch.refetchSidebar({ orgChanged: true });
    const first = vi.fn();
    const unregister = refetch.registerSidebarRefetch(first);
    await Promise.resolve();

    const later = vi.fn();
    refetch.registerSidebarRefetch(later);
    expect(first).toHaveBeenCalledTimes(1);
    expect(later).not.toHaveBeenCalled();
    unregister();
  });

  it("keeps a newer refetch queued after an earlier replay", async () => {
    refetch.refetchSidebar({ orgChanged: true });
    const unregister = refetch.registerSidebarRefetch(vi.fn());
    unregister();
    refetch.refetchSidebar({ workflowCreated: true });
    await Promise.resolve();

    const later = vi.fn();
    refetch.registerSidebarRefetch(later);
    expect(later).toHaveBeenCalledWith({ workflowCreated: true });
  });
});
