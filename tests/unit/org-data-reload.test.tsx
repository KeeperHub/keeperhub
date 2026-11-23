// @vitest-environment jsdom
import { createStore, Provider } from "jotai";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { orgDataReadyAtom } from "@/lib/atoms/organization";
import { useOrganizationsData } from "@/lib/hooks/use-org-data";

let container: HTMLDivElement;
let root: Root;
let reload: () => Promise<boolean> = () => Promise.resolve(false);
const fetchMock = vi.fn();

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function Probe(): null {
  reload = useOrganizationsData().reload;
  return null;
}

function answer(status: number): Response {
  return new Response(JSON.stringify(status === 200 ? [] : {}), { status });
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  const store = createStore();
  store.set(orgDataReadyAtom, true);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root.render(
      <Provider store={store}>
        <Probe />
      </Provider>
    )
  );
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("useOrganizationsData().reload", () => {
  it("asks for the list again and resolves once it has arrived", async () => {
    let arrive: (response: Response) => void = () => undefined;
    fetchMock.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          arrive = resolve;
        })
    );
    let settled = false;
    const reloading = reload().then((loaded) => {
      settled = true;
      return loaded;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchMock).toHaveBeenCalledWith("/api/organizations");
    expect(settled).toBe(false);
    arrive(answer(200));
    expect(await reloading).toBe(true);
  });

  it("resolves to false when the list fails to load", async () => {
    fetchMock.mockImplementation(() => Promise.resolve(answer(500)));
    expect(await reload()).toBe(false);
    fetchMock.mockImplementation(() => Promise.resolve(answer(503)));
    expect(await reload()).toBe(false);
  });

  it("answers each of two reloads at once", async () => {
    fetchMock.mockImplementation(() => Promise.resolve(answer(200)));
    await expect(Promise.all([reload(), reload()])).resolves.toEqual([
      true,
      true,
    ]);
  });
});
