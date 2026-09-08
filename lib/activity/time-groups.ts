/**
 * Date-grouping for history/activity timelines, Google-Docs style:
 * "Today", "Yesterday", "This week", then a per-month bucket. Pure and
 * deterministic given a `now` (injectable for tests). Newest-first input is
 * preserved within each group.
 */

export type DateGroup<T> = { label: string; items: T[] };

const DAY_MS = 24 * 60 * 60 * 1000;

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

const MONTH_FORMAT = new Intl.DateTimeFormat("en-US", {
  month: "long",
  year: "numeric",
});

function labelFor(iso: string, now: Date): string {
  const date = new Date(iso);
  const today = startOfDay(now);
  const itemDay = startOfDay(date);
  const diffDays = Math.round((today - itemDay) / DAY_MS);

  if (diffDays <= 0) {
    return "Today";
  }
  if (diffDays === 1) {
    return "Yesterday";
  }
  if (diffDays < 7) {
    return "This week";
  }
  return MONTH_FORMAT.format(date);
}

export function groupByDate<T>(
  items: T[],
  getISO: (item: T) => string,
  now: Date = new Date()
): DateGroup<T>[] {
  const groups: DateGroup<T>[] = [];
  const byLabel = new Map<string, DateGroup<T>>();

  for (const item of items) {
    const label = labelFor(getISO(item), now);
    let group = byLabel.get(label);
    if (!group) {
      group = { label, items: [] };
      byLabel.set(label, group);
      groups.push(group);
    }
    group.items.push(item);
  }

  return groups;
}
