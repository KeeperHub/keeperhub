/** Ancestors the user can scroll, nearest first; overflow-hidden layout boxes are skipped. */
function scrollBoxes(element: HTMLElement): HTMLElement[] {
  const boxes: HTMLElement[] = [];
  for (let node = element.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if (
      (overflowY === "auto" || overflowY === "scroll") &&
      node.scrollHeight > node.clientHeight
    ) {
      boxes.push(node);
    }
  }
  return boxes;
}

/** What the eye sees for a control: a visually hidden input shows as its label. */
function shownPart(element: HTMLElement): HTMLElement {
  const rect = element.getBoundingClientRect();
  if (rect.width > 1 || rect.height > 1) {
    return element;
  }
  return element.closest("label") ?? element.parentElement ?? element;
}

/**
 * Focus without the browser's own scroll, which also moves overflow-hidden
 * layout boxes and can push a whole panel up. Only scrolling panels move.
 */
export function focusInPlace(element: HTMLElement | null | undefined): void {
  if (!element) {
    return;
  }
  element.focus({ preventScroll: true });
  const shown = shownPart(element);
  for (const box of scrollBoxes(element)) {
    const target = shown.getBoundingClientRect();
    const view = box.getBoundingClientRect();
    if (target.top < view.top) {
      box.scrollTop -= view.top - target.top;
    } else if (target.bottom > view.bottom) {
      box.scrollTop += Math.min(
        target.bottom - view.bottom,
        target.top - view.top
      );
    }
  }
}
