// @vitest-environment jsdom
import { act } from "react";
import { createPortal } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePressGrace } from "@/hooks/use-press-grace";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const GRACE_MS = 350;
let clock = 0;
let container: HTMLDivElement;
let root: Root;
let grace: ReturnType<typeof usePressGrace>;
const onInside = vi.fn();
const onPortaled = vi.fn();

// A guarded area holding a button, and a menu portaled out of it (as Radix
// menus are) whose React events still pass through the area.
function Area(): React.ReactNode {
  grace = usePressGrace(GRACE_MS);
  return (
    <div
      onClickCapture={grace.onClickCapture}
      onPointerDownCapture={grace.onPointerDownCapture}
    >
      <button data-testid="inside" onClick={onInside} type="button">
        Row
      </button>
      {createPortal(
        <button data-testid="portaled" onClick={onPortaled} type="button">
          Option
        </button>,
        document.body
      )}
    </div>
  );
}

function tap(testId: string, at: number): void {
  const element = document.querySelector<HTMLElement>(
    `[data-testid=${testId}]`
  );
  if (!element) {
    throw new Error(`${testId} not found`);
  }
  clock = at;
  const press = new Event("pointerdown", { bubbles: true, cancelable: true });
  Object.defineProperty(press, "timeStamp", { value: at });
  act(() => {
    element.dispatchEvent(press);
    element.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 })
    );
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  clock = 0;
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<Area />));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe("usePressGrace", () => {
  it("drops a press on the area in the grace, not one in a portaled menu", () => {
    clock = 1000;
    grace.start();
    tap("inside", 1100);
    expect(onInside).not.toHaveBeenCalled();
    tap("portaled", 1150);
    expect(onPortaled).toHaveBeenCalledTimes(1);
    tap("inside", 1400);
    expect(onInside).toHaveBeenCalledTimes(1);
  });

  it("starts again at the next frame, and cancels that frame on unmount", () => {
    const frames = new Map<number, FrameRequestCallback>();
    let nextId = 0;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((frame) => {
      nextId += 1;
      frames.set(nextId, frame);
      return nextId;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
      frames.delete(id);
    });

    clock = 1000;
    grace.startThroughNextPaint();
    // A second start replaces the pending frame rather than adding one.
    grace.startThroughNextPaint();
    expect(frames.size).toBe(1);
    clock = 1300;
    for (const frame of frames.values()) {
      frame(1300);
    }
    frames.clear();
    // Measured from the painted frame: 1300 + 350.
    clock = 1700;
    expect(grace.inGrace(1600)).toBe(true);
    expect(grace.inGrace(1700)).toBe(false);

    grace.startThroughNextPaint();
    expect(frames.size).toBe(1);
    act(() => root.unmount());
    expect(frames.size).toBe(0);
    root = createRoot(container);
  });
});
