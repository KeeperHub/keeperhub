import { createStore } from "jotai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api-client", () => ({
  api: {
    project: { getAll: vi.fn().mockResolvedValue([]) },
    tag: { getAll: vi.fn().mockResolvedValue([]) },
  },
}));

import {
  activeOrgScopeAtom,
  orgDataReadyAtom,
  walletAtom,
  walletRefreshAtom,
} from "@/lib/atoms/organization";

const WALLETS: Record<string, string> = {
  "org-a": "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "org-b": "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
};

// The route reads the active organization from the session, so the stub is
// keyed on whichever org the store currently says is in scope.
let servedOrg = "org-a";
const fetchMock = vi.fn(() =>
  Promise.resolve({
    ok: true,
    json: () =>
      Promise.resolve({
        hasWallet: true,
        walletAddress: WALLETS[servedOrg],
      }),
  } as unknown as Response)
);

async function scopeTo(
  store: ReturnType<typeof createStore>,
  orgId: string
): Promise<string | null | undefined> {
  servedOrg = orgId;
  store.set(activeOrgScopeAtom, orgId);
  const summary = await store.get(walletAtom);
  return summary?.walletAddress;
}

describe("organization-scoped wallet atom", () => {
  let store: ReturnType<typeof createStore>;

  beforeEach(() => {
    fetchMock.mockClear();
    servedOrg = "org-a";
    vi.stubGlobal("fetch", fetchMock);
    store = createStore();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not fetch before the client marks the store ready", async () => {
    store.set(activeOrgScopeAtom, "org-a");
    expect(await store.get(walletAtom)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not fetch until an organization is in scope", async () => {
    store.set(orgDataReadyAtom, true);
    expect(await store.get(walletAtom)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refetches the wallet when the active organization changes", async () => {
    store.set(orgDataReadyAtom, true);

    expect(await scopeTo(store, "org-a")).toBe(WALLETS["org-a"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // The regression this guards: the address kept showing the previous
    // organization's wallet because nothing re-ran on the switch.
    expect(await scopeTo(store, "org-b")).toBe(WALLETS["org-b"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    expect(await scopeTo(store, "org-a")).toBe(WALLETS["org-a"]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("refetches when the refresh counter is bumped", async () => {
    store.set(orgDataReadyAtom, true);
    await scopeTo(store, "org-a");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    store.set(walletRefreshAtom, (n) => n + 1);
    await store.get(walletAtom);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("reports no wallet when the route rejects the request", async () => {
    store.set(orgDataReadyAtom, true);
    fetchMock.mockResolvedValueOnce({ ok: false } as unknown as Response);
    store.set(activeOrgScopeAtom, "org-a");
    expect(await store.get(walletAtom)).toEqual({ hasWallet: false });
  });
});
