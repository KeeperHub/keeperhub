/**
 * The state machine behind picking a date range, kept out of the component so
 * it can be tested directly. Two clicks make a range: the first names a start,
 * the second closes it. A click on an already-closed range starts over.
 *
 * This is deliberately not react-day-picker's own range accumulation. Handed a
 * committed range as its current value, that reads the next click as closing
 * the existing range and reports both ends at once, which made the picker apply
 * and dismiss on every single click.
 */
export type RangeStep =
  | { kind: "start"; from: Date }
  | { kind: "complete"; from: Date; to: Date };

export type RangeDraft = { from?: Date; to?: Date } | undefined;

export function startOfDay(date: Date): Date {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

/** Inclusive end: the last instant of the day, so that day is in the window. */
export function endOfDay(date: Date): Date {
  const copy = new Date(date);
  copy.setHours(23, 59, 59, 999);
  return copy;
}

export function nextRangeStep(draft: RangeDraft, day: Date): RangeStep {
  // Nothing started, or the last range is already closed: begin a new one.
  if (!draft?.from || draft.to) {
    return { kind: "start", from: day };
  }
  // Clicking before the start reads as picking the other end, not as a
  // backwards range, so the two swap rather than producing an empty window.
  const backwards = day.getTime() < draft.from.getTime();
  const from = backwards ? day : draft.from;
  const to = backwards ? draft.from : day;
  return { kind: "complete", from: startOfDay(from), to: endOfDay(to) };
}
