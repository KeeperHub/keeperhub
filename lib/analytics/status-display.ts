import type { NormalizedStatus } from "./types";

/**
 * The one place a run status gets its name and its colour. The runs table, the
 * status filter and the chart above it all read from here, so a colour a reader
 * learns in one of them means the same thing in the other two.
 *
 * `chartColor` is a CSS value because recharts takes a fill, not a class; it is
 * the same hue as `dot` so the band and the swatch match.
 */
export type StatusDisplay = {
  label: string;
  /** Swatch class for the filter list. */
  dot: string;
  /** Badge classes for a run row. */
  badge: string;
  chartColor: string;
};

export const STATUS_DISPLAY: Record<NormalizedStatus, StatusDisplay> = {
  success: {
    label: "Success",
    dot: "bg-green-500",
    badge:
      "bg-green-500/10 text-green-700 dark:text-green-400 border-green-500/20",
    chartColor: "var(--color-green-500)",
  },
  error: {
    label: "Error",
    dot: "bg-red-500",
    badge: "bg-red-500/10 text-red-700 dark:text-red-400 border-red-500/20",
    chartColor: "var(--color-red-500)",
  },
  external_error: {
    label: "External",
    dot: "bg-purple-500",
    badge:
      "bg-purple-500/10 text-purple-700 dark:text-purple-400 border-purple-500/20",
    chartColor: "var(--color-purple-500)",
  },
  system_error: {
    label: "System Error",
    dot: "bg-amber-500",
    badge:
      "bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/20",
    chartColor: "var(--color-amber-500)",
  },
  cancelled: {
    label: "Cancelled",
    dot: "bg-orange-500",
    badge:
      "bg-orange-500/10 text-orange-700 dark:text-orange-400 border-orange-500/20",
    chartColor: "var(--color-orange-500)",
  },
  // Refused before it started: neutral everywhere, so it never reads as a
  // failure, in a badge or as a band on the chart.
  skipped: {
    label: "Skipped",
    dot: "bg-muted-foreground",
    badge: "bg-muted text-muted-foreground border-border",
    chartColor: "var(--color-muted-foreground)",
  },
  running: {
    label: "Running",
    dot: "bg-blue-500",
    badge: "bg-blue-500/10 text-blue-700 dark:text-blue-400 border-blue-500/20",
    chartColor: "var(--color-blue-500)",
  },
  pending: {
    label: "Pending",
    dot: "bg-gray-500",
    badge: "bg-gray-500/10 text-gray-700 dark:text-gray-400 border-gray-500/20",
    chartColor: "var(--color-gray-500)",
  },
};
