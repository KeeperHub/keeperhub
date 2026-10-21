// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MobileWarningDialog } from "@/components/mobile-warning-dialog";

const mocks = vi.hoisted(() => ({ pathname: "/" }));

vi.mock("next/navigation", () => ({
  usePathname: () => mocks.pathname,
}));

const WARNING = "Desktop Optimized";
const DESKTOP_WIDTH = window.innerWidth;

let container: HTMLDivElement;
let root: Root;

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function renderAt(pathname: string): void {
  mocks.pathname = pathname;
  act(() => root.render(<MobileWarningDialog />));
}

function setWidth(width: number): void {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: width,
  });
}

beforeEach(() => {
  localStorage.clear();
  setWidth(375);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  setWidth(DESKTOP_WIDTH);
});

describe("MobileWarningDialog", () => {
  it("warns on a phone inside the app", () => {
    renderAt("/hub");
    expect(container.textContent).toContain(WARNING);
  });

  it.each([
    "/welcome",
    "/welcome/create-org",
    "/verify-mfa",
    "/enroll-mfa",
    "/enforce-mfa",
    "/verify-ip",
  ])("does not cover %s", (pathname) => {
    renderAt(pathname);
    expect(container.textContent).not.toContain(WARNING);
  });

  it("warns once the visitor moves on from the welcome page", () => {
    renderAt("/welcome");
    expect(container.textContent).not.toContain(WARNING);
    // A client-side move keeps the dialog mounted: no new mount, no new check.
    renderAt("/enroll-mfa");
    expect(container.textContent).not.toContain(WARNING);
    renderAt("/hub");
    expect(container.textContent).toContain(WARNING);
  });

  it("does not warn on a wide screen or once dismissed", () => {
    setWidth(1280);
    renderAt("/hub");
    expect(container.textContent).not.toContain(WARNING);
    act(() => root.unmount());

    setWidth(375);
    localStorage.setItem("keeperhub-mobile-warning-dismissed", "true");
    root = createRoot(container);
    renderAt("/hub");
    expect(container.textContent).not.toContain(WARNING);
  });
});
