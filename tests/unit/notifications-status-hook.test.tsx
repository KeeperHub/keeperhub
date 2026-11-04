// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  invalidateNotificationStatus,
  useNotificationStatus,
} from "@/lib/hooks/use-notifications";

type Status = ReturnType<typeof useNotificationStatus>["status"];

let container: HTMLDivElement;
let root: Root;
const seen: Record<string, Status> = {};

function Probe({ id, org }: { id: string; org: string }): null {
  seen[id] = useNotificationStatus(org).status;
  return null;
}

function deferred(): {
  promise: Promise<Response>;
  resolve: (body: unknown) => void;
} {
  let resolve: (body: unknown) => void = () => undefined;
  const promise = new Promise<Response>((done) => {
    resolve = (body) =>
      done({ ok: true, json: () => Promise.resolve(body) } as Response);
  });
  return { promise, resolve };
}

const reply = (alertsEnabled: boolean, types: string[] = []): unknown => ({
  unreadCount: types.length,
  types,
  alertsEnabled,
});

beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  // Each test uses its own org ids, so the shared cache never carries over.
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("useNotificationStatus", () => {
  it("names the org it asks about", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(reply(true)),
    });
    vi.stubGlobal("fetch", fetchMock);

    await act(async () => {
      root.render(<Probe id="a" org="org-named" />);
    });

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.headers).toEqual({ "X-Organization-Id": "org-named" });
    expect(seen.a?.alertsEnabled).toBe(true);
  });

  it("reads a failed status request as unknown and asks again next time", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 500 })
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(reply(true)),
      });
    vi.stubGlobal("fetch", fetchMock);

    await act(async () => {
      root.render(<Probe id="e" org="org-error" />);
    });
    expect(seen.e?.alertsEnabled).toBeNull();

    await act(async () => {
      invalidateNotificationStatus("org-error");
    });
    expect(seen.e?.alertsEnabled).toBeNull();

    // Not cached: a remount asks again.
    act(() => root.unmount());
    root = createRoot(container);
    await act(async () => {
      root.render(<Probe id="e" org="org-error" />);
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(seen.e?.alertsEnabled).toBe(true);
  });

  it("resets on an org change and drops the old org's late answer", async () => {
    const first = deferred();
    const second = deferred();
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockReturnValueOnce(first.promise)
        .mockReturnValueOnce(second.promise)
    );

    await act(async () => {
      root.render(<Probe id="b" org="org-slow" />);
    });
    await act(async () => {
      root.render(<Probe id="b" org="org-next" />);
    });
    expect(seen.b?.alertsEnabled).toBeNull();

    await act(async () => {
      first.resolve(reply(true, ["failure_alerts_unreachable"]));
    });
    expect(seen.b?.alertsEnabled).toBeNull();
    expect(seen.b?.types).toEqual([]);

    await act(async () => {
      second.resolve(reply(false));
    });
    expect(seen.b?.alertsEnabled).toBe(false);
  });

  it("invalidate refetches once for every caller of that org", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve(reply(true, ["failure_alerts_unreachable"])),
      })
      .mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(reply(true)),
      });
    vi.stubGlobal("fetch", fetchMock);

    await act(async () => {
      root.render(
        <>
          <Probe id="banner" org="org-saved" />
          <Probe id="menu" org="org-saved" />
        </>
      );
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(seen.banner?.types).toEqual(["failure_alerts_unreachable"]);

    await act(async () => {
      invalidateNotificationStatus("org-saved");
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(seen.banner?.types).toEqual([]);
    expect(seen.menu?.types).toEqual([]);
  });
});
