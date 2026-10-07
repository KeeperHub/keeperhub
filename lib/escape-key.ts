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
