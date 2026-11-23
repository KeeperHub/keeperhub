// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DualFactorSteps } from "@/components/auth/dual-factor-steps";
import type { UseDualFactorState } from "@/lib/mfa/use-dual-factor-state";

const actGlobal = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };

let container: HTMLDivElement;
let root: Root;

function dualWithEmailCode(): UseDualFactorState {
  return {
    totpCode: "",
    emailOtp: "123456",
    awaitingEmailOtp: true,
    setTotpCode: vi.fn(),
    setEmailOtp: vi.fn(),
    setAwaitingEmailOtp: vi.fn(),
    reset: vi.fn(),
    isReady: false,
    handleResponse: vi.fn(() => false),
    prefetchEmail: vi.fn(async () => undefined),
    resendEmail: vi.fn(async () => true),
  };
}

function renderSteps(): void {
  actGlobal.IS_REACT_ACT_ENVIRONMENT = true;
  act(() =>
    root.render(
      <DualFactorSteps
        dual={dualWithEmailCode()}
        onBack={vi.fn()}
        onPrefetchEmail={vi.fn(async () => undefined)}
        onResendEmail={vi.fn(async () => true)}
        onSubmit={vi.fn(async () => undefined)}
      />
    )
  );
  // The checks below click from script and read focus as soon as the event
  // returns, before React's scheduled work runs, so they show focus moving
  // inside the handler itself.
  actGlobal.IS_REACT_ACT_ENVIRONMENT = false;
}

function button(label: string): HTMLButtonElement {
  const match = [...container.querySelectorAll("button")].find(
    (node) => node.textContent === label
  );
  if (!match) {
    throw new Error(`${label} button not found`);
  }
  return match;
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  actGlobal.IS_REACT_ACT_ENVIRONMENT = true;
  act(() => root.unmount());
  container.remove();
});

describe("DualFactorSteps step change", () => {
  // Each step change focuses the field of the step it opens within the event
  // handler, not in a later render.
  it("focuses the authenticator field during the Continue click", () => {
    renderSteps();
    button("Continue").click();
    expect(document.activeElement?.id).toBe("dfs-totp");
  });

  it("focuses the authenticator field during Enter in the email field", () => {
    renderSteps();
    const email = container.querySelector("#dfs-email-verify");
    email?.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, key: "Enter" })
    );
    expect(document.activeElement?.id).toBe("dfs-totp");
  });

  it("focuses the email field during the Back click", () => {
    renderSteps();
    // Settle on the authenticator step first, so focus has left the email field.
    actGlobal.IS_REACT_ACT_ENVIRONMENT = true;
    act(() => button("Continue").click());
    actGlobal.IS_REACT_ACT_ENVIRONMENT = false;
    expect(document.activeElement?.id).toBe("dfs-totp");
    button("Back").click();
    expect(document.activeElement?.id).toBe("dfs-email-verify");
  });
});

describe("DualFactorSteps and the on-screen keyboard", () => {
  // jsdom has no visual viewport; this stands in for one an open keyboard has
  // shrunk.
  class FakeVisualViewport extends EventTarget {
    height = 367;
    offsetTop = 0;
  }

  const original = Object.getOwnPropertyDescriptor(window, "visualViewport");
  let viewport: FakeVisualViewport;
  const rootStyle = (): CSSStyleDeclaration => document.documentElement.style;

  beforeEach(() => {
    viewport = new FakeVisualViewport();
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      value: viewport,
    });
  });

  afterEach(() => {
    if (original) {
      Object.defineProperty(window, "visualViewport", original);
    } else {
      Reflect.deleteProperty(window, "visualViewport");
    }
  });

  it("marks itself for the keyboard-safe window around it", () => {
    renderSteps();
    expect(container.querySelector("[data-keyboard-safe]")).not.toBeNull();
  });

  it("mirrors the visible height into CSS variables while mounted", () => {
    renderSteps();
    expect(rootStyle().getPropertyValue("--visual-viewport-height")).toBe(
      "367px"
    );
    expect(rootStyle().getPropertyValue("--visual-viewport-top")).toBe("0px");

    viewport.height = 420;
    viewport.offsetTop = 12;
    viewport.dispatchEvent(new Event("resize"));
    expect(rootStyle().getPropertyValue("--visual-viewport-height")).toBe(
      "420px"
    );
    expect(rootStyle().getPropertyValue("--visual-viewport-top")).toBe("12px");

    // iOS pans the page under an open keyboard without resizing.
    viewport.offsetTop = 30;
    viewport.dispatchEvent(new Event("scroll"));
    expect(rootStyle().getPropertyValue("--visual-viewport-top")).toBe("30px");

    actGlobal.IS_REACT_ACT_ENVIRONMENT = true;
    act(() => root.render(<div />));
    expect(rootStyle().getPropertyValue("--visual-viewport-height")).toBe("");
    expect(rootStyle().getPropertyValue("--visual-viewport-top")).toBe("");
  });

  it("keeps the variables while another code entry is still mounted", () => {
    renderSteps();
    const otherContainer = document.createElement("div");
    document.body.appendChild(otherContainer);
    const otherRoot = createRoot(otherContainer);
    actGlobal.IS_REACT_ACT_ENVIRONMENT = true;
    act(() =>
      otherRoot.render(
        <DualFactorSteps
          dual={dualWithEmailCode()}
          onBack={vi.fn()}
          onPrefetchEmail={vi.fn(async () => undefined)}
          onResendEmail={vi.fn(async () => true)}
          onSubmit={vi.fn(async () => undefined)}
        />
      )
    );

    act(() => otherRoot.unmount());
    otherContainer.remove();
    expect(rootStyle().getPropertyValue("--visual-viewport-height")).toBe(
      "367px"
    );

    act(() => root.render(<div />));
    expect(rootStyle().getPropertyValue("--visual-viewport-height")).toBe("");
  });
});
