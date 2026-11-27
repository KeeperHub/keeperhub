// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  listConfigs: vi.fn(),
  getPolicy: vi.fn(),
}));

vi.mock("@/lib/auth-client", () => ({
  authClient: {
    useActiveOrganization: () => ({ data: { id: "org_1" } }),
  },
}));
vi.mock("@/lib/rpc/org-rpc-client", () => ({ orgRpcApi: api }));

import { useOrgRpcState } from "@/components/workflow/config/use-org-rpc-state";
import { readCachedResource } from "@/lib/hooks/use-cached-resource";

let container: HTMLDivElement;
let root: Root;
let seen: ReturnType<typeof useOrgRpcState> | undefined;

function Probe(): null {
  seen = useOrgRpcState();
  return null;
}

beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  container = document.createElement("div");
  root = createRoot(container);
  seen = undefined;
});

afterEach(() => {
  act(() => root.unmount());
  vi.restoreAllMocks();
});

describe("useOrgRpcState", () => {
  it("reports a failed load instead of caching it as an empty setup", async () => {
    api.listConfigs.mockRejectedValue(new Error("network down"));
    api.getPolicy.mockResolvedValue({ chains: [] });

    await act(async () => {
      root.render(<Probe />);
      await Promise.resolve();
    });

    expect(seen?.failed).toBe(true);
    expect(seen?.loading).toBe(false);
    expect(readCachedResource("org-rpc-editor:org_1")).toBeUndefined();
  });
});
