// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TruncatedTooltip } from "@/components/ui/truncated-tooltip";

const BOX_WIDTH = 50;
const CHAR_WIDTH = 10;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  // jsdom has no layout: give the span a fixed width and text that takes
  // room by its length, as a fixed-width label does.
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(
    BOX_WIDTH
  );
  vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(
    function (this: HTMLElement) {
      return (this.textContent?.length ?? 0) * CHAR_WIDTH;
    }
  );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe("TruncatedTooltip", () => {
  it("measures again when the text changes in a box that keeps its size", () => {
    const onTruncatedChange = vi.fn();
    const render = (text: string): void =>
      act(() =>
        root.render(
          <TruncatedTooltip onTruncatedChange={onTruncatedChange} text={text} />
        )
      );

    render("5 min");
    expect(onTruncatedChange).toHaveBeenLastCalledWith(false);

    render("LiquidationTriggered");
    expect(onTruncatedChange).toHaveBeenLastCalledWith(true);

    render("Daily");
    expect(onTruncatedChange).toHaveBeenLastCalledWith(false);
  });
});
