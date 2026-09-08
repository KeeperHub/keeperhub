"use client";

import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { SETTINGS_HEAD_ROW, SETTINGS_ROW, StatTile } from "./section";

const KEYS = ["a", "b", "c", "d", "e", "f"] as const;

export function FormSkeleton({ rows = 2 }: { rows?: number }): React.ReactNode {
  return (
    <div className="space-y-5">
      {KEYS.slice(0, rows).map((key) => (
        <div className="space-y-2" key={key}>
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-9 w-full" />
        </div>
      ))}
    </div>
  );
}

export function RowsSkeleton({ rows = 4 }: { rows?: number }): React.ReactNode {
  return (
    <div className="space-y-2">
      {KEYS.slice(0, rows).map((key) => (
        <div
          className="flex items-center gap-3 rounded-lg border px-3 py-3"
          key={key}
        >
          <Skeleton className="size-8 shrink-0 rounded-full" />
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-3 w-32" />
            <Skeleton className="h-2.5 w-48" />
          </div>
          <Skeleton className="h-6 w-16 rounded-full" />
        </div>
      ))}
    </div>
  );
}

export function CardGridSkeleton({
  cards = 3,
}: {
  cards?: number;
}): React.ReactNode {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {KEYS.slice(0, cards).map((key) => (
        <div className="space-y-4 rounded-xl border bg-card/60 p-4" key={key}>
          <div className="flex items-center gap-3">
            <Skeleton className="size-9 rounded-lg" />
            <div className="space-y-1.5">
              <Skeleton className="h-3.5 w-28" />
              <Skeleton className="h-2.5 w-16" />
            </div>
          </div>
          <Skeleton className="h-8 w-24" />
          <Skeleton className="h-8 w-full" />
        </div>
      ))}
    </div>
  );
}

/**
 * The real tiles, waiting. Drawing an approximation of them is what made a
 * page shift when the figures arrived.
 */
export function StatTilesSkeleton({
  tiles = 3,
}: {
  tiles?: number;
}): React.ReactNode {
  return (
    <div className="grid gap-4 sm:grid-cols-3">
      {KEYS.slice(0, tiles).map((key) => (
        <StatTile hint="" key={key} label="" loading value="" />
      ))}
    </div>
  );
}

/**
 * Stands in for a settings table. Built from the same primitives and row
 * classes as the real one, so a row is the same height either way and the
 * card does not resize when the data lands.
 */
export function TableSkeleton({
  columns,
  rows = 3,
  lines = 1,
  leading = false,
}: {
  columns: number;
  rows?: number;
  /** Two for rows that carry a second line, e.g. an address under a name. */
  lines?: 1 | 2;
  /** An avatar or icon ahead of the text. */
  leading?: boolean;
}): React.ReactNode {
  const rest = Array.from({ length: Math.max(columns - 1, 0) }, (_, i) => i);
  return (
    <Table>
      <TableHeader>
        <TableRow className={SETTINGS_HEAD_ROW}>
          <TableHead>
            <Skeleton className="h-3 w-16" />
          </TableHead>
          {rest.map((i) => (
            <TableHead key={i}>
              <Skeleton className="h-3 w-12" />
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {KEYS.slice(0, rows).map((key) => (
          <TableRow className={SETTINGS_ROW} key={key}>
            <TableCell>
              <div className="flex items-center gap-3">
                {leading && <Skeleton className="size-8 shrink-0 rounded-lg" />}
                <div className="flex flex-col gap-1.5">
                  <Skeleton className="h-4 w-40" />
                  {lines === 2 && <Skeleton className="h-3 w-56" />}
                </div>
              </div>
            </TableCell>
            {rest.map((i) => (
              <TableCell key={i}>
                <Skeleton className="h-4 w-16" />
              </TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
