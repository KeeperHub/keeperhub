// @vitest-environment jsdom
/**
 * The dialog's own test, added because the shared phone test moved its
 * condition and it is now the only caller of `isPhoneLikeViewport` outside the
 * editor gate.
 *
 * The width half of the condition is the one that failed: the phone test is
 * false on any desktop, so testing only that half opened the "use a larger
 * screen" modal over every route on every desktop that had never written the
 * dismissal key, which is every desktop user.
 */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MobileWarningDialog } from "@/components/mobile-warning-dialog";

const DESKTOP_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";
const PHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";
const STORAGE_KEY = "keeperhub-mobile-warning-dismissed";

let width = 1440;
let coarse = false;
let userAgent = DESKTOP_UA;
let dismissed: string | null = null;

function installStubs(): void {
  const store = {
    getItem: (key: string) => (key === STORAGE_KEY ? dismissed : null),
    setItem: (_key: string, value: string) => {
      dismissed = value;
    },
    removeItem: () => {
      dismissed = null;
    },
    clear: () => {
      dismissed = null;
    },
    key: () => null,
    length: 0,
  } as unknown as Storage;
  // The component reads the bare global, so the global is what is stubbed.
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: store,
  });
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: store,
  });
  // A getter rather than a fixed value: the cases move `coarse` after the stub is
  // installed, and the device half of the dialog's condition now reads the user
  // agent, so it has to move with them.
  Object.defineProperty(navigator, "userAgent", {
    configurable: true,
    get: () => userAgent,
  });
  window.matchMedia = ((query: string) => ({
    matches: query.includes("pointer: coarse")
      ? coarse
      : query.includes("max-width: 767px") && width < 768,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

function mountDialog(): HTMLElement {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(<MobileWarningDialog />);
  });
  return container;
}

beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  width = 1440;
  coarse = false;
  userAgent = DESKTOP_UA;
  dismissed = null;
  document.body.innerHTML = "";
  installStubs();
});

describe("MobileWarningDialog", () => {
  it("stays closed on a desktop, at any width", () => {
    for (const w of [1440, 1920, 768]) {
      width = w;
      expect(mountDialog().textContent).not.toContain("Desktop Optimized");
    }
  });

  it("opens for a narrow desktop window", () => {
    // 700px with a mouse: the case the warning is for.
    width = 700;
    expect(mountDialog().textContent).toContain("Desktop Optimized");
  });

  it("stays closed on a phone", () => {
    // A phone has a monitoring surface and a workflow route that states its own
    // case, so this warning would be a second, contradictory one.
    width = 390;
    coarse = true;
    userAgent = PHONE_UA;
    expect(mountDialog().textContent).not.toContain("Desktop Optimized");
  });

  it("stays closed once dismissed", () => {
    width = 700;
    dismissed = "true";
    expect(mountDialog().textContent).not.toContain("Desktop Optimized");
  });
});
