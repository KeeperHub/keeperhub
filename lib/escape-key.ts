// Escape presses a control has already used (the search box clearing its
// text, a chip closing the filter). The sidebar's document listener checks
// this instead of `defaultPrevented`, which an open Radix tooltip also sets
// when it closes itself, and which would otherwise make the panel need an
// extra press to close.
const handledEscapes = new WeakSet<Event>();

export function markEscapeHandled(event: Event): void {
  handledEscapes.add(event);
}

export function isEscapeHandled(event: Event): boolean {
  return handledEscapes.has(event);
}

// Focus sits inside these while a dialog, menu, select or popover is open,
// and Escape there is for closing that.
const OVERLAY_SELECTOR =
  '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]';

/**
 * Whether an Escape closed (or was for) an overlay the focus was in. The
 * overlay may already be gone from the page when this runs, which does not
 * matter: the focused element still knows its old ancestors.
 */
export function isEscapeFromOverlay(event: Event): boolean {
  const target = event.target;
  return target instanceof Element && target.closest(OVERLAY_SELECTOR) !== null;
}
