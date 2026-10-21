"use client";

import {
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import type { PageMeta } from "@/lib/pagination";

// The phone pager's step buttons. They are aria-disabled rather than
// disabled: they turn off as soon as they reach an end, and a disabled button
// drops keyboard focus out of the pager. The desktop window keeps its own
// Previous/Next, unchanged.
function PhoneStepButton({
  children,
  label,
  onGo,
}: {
  children: React.ReactNode;
  label: string;
  onGo: (() => void) | null;
}): React.ReactElement {
  return (
    <Button
      aria-disabled={onGo === null}
      aria-label={label}
      className="aria-disabled:pointer-events-none aria-disabled:opacity-50 sm:hidden"
      onClick={() => onGo?.()}
      size="icon-sm"
      variant="ghost"
    >
      {children}
    </Button>
  );
}

/** First, last, and the current page +/-1, collapsing gaps to an ellipsis. */
function pageWindow(page: number, totalPages: number): (number | "gap")[] {
  const wanted = new Set<number>([1, totalPages, page - 1, page, page + 1]);
  const visible = [...wanted]
    .filter((p) => p >= 1 && p <= totalPages)
    .sort((a, b) => a - b);

  const out: (number | "gap")[] = [];
  let previous = 0;
  for (const p of visible) {
    if (previous && p - previous > 1) {
      out.push("gap");
    }
    out.push(p);
    previous = p;
  }
  return out;
}

export function Pager({
  meta,
  onPage,
  unit = "items",
}: {
  meta: PageMeta;
  onPage: (page: number) => void;
  unit?: string;
}): React.ReactElement | null {
  const { page, totalPages, total } = meta;
  if (total === 0) {
    return null;
  }

  return (
    // On phones the numbered window gives way to first/last buttons around a
    // "Page X of Y" label; if even that does not fit beside the count, the
    // buttons wrap to a row of their own instead of overflowing.
    <div className="flex items-center justify-between gap-2 max-sm:flex-wrap max-sm:gap-y-2">
      <span className="text-muted-foreground text-xs">
        {total} {unit}
      </span>
      {totalPages > 1 && (
        <nav
          aria-label="Pagination"
          className="flex items-center gap-0.5 max-sm:ml-auto"
        >
          <PhoneStepButton
            label="First page"
            onGo={page > 1 ? () => onPage(1) : null}
          >
            <ChevronsLeft className="size-4" />
          </PhoneStepButton>
          <PhoneStepButton
            label="Previous page"
            onGo={page > 1 ? () => onPage(page - 1) : null}
          >
            <ChevronLeft className="size-4" />
          </PhoneStepButton>
          <Button
            aria-label="Previous page"
            className="max-sm:hidden"
            disabled={page <= 1}
            onClick={() => onPage(page - 1)}
            size="icon-sm"
            variant="ghost"
          >
            <ChevronLeft className="size-4" />
          </Button>
          {pageWindow(page, totalPages).map((p, i) =>
            p === "gap" ? (
              <span
                className="px-1 text-muted-foreground text-xs max-sm:hidden"
                // biome-ignore lint/suspicious/noArrayIndexKey: gaps are positional and static
                key={`gap-${i}`}
              >
                ...
              </span>
            ) : (
              <Button
                aria-current={p === page ? "page" : undefined}
                className="min-w-7 max-sm:hidden"
                key={p}
                onClick={() => onPage(p)}
                size="icon-sm"
                variant={p === page ? "default" : "ghost"}
              >
                {p}
              </Button>
            )
          )}
          {/* Sized by an invisible copy of the widest label, so the buttons
              keep their place (and the row its wrap) from page to page. */}
          <span className="grid whitespace-nowrap px-0.5 text-center text-muted-foreground text-xs tabular-nums sm:hidden">
            <span
              aria-hidden="true"
              className="invisible col-start-1 row-start-1"
            >
              Page {totalPages} of {totalPages}
            </span>
            <span
              aria-atomic="true"
              aria-live="polite"
              className="col-start-1 row-start-1"
            >
              Page {page} of {totalPages}
            </span>
          </span>
          <Button
            aria-label="Next page"
            className="max-sm:hidden"
            disabled={page >= totalPages}
            onClick={() => onPage(page + 1)}
            size="icon-sm"
            variant="ghost"
          >
            <ChevronRight className="size-4" />
          </Button>
          <PhoneStepButton
            label="Next page"
            onGo={page < totalPages ? () => onPage(page + 1) : null}
          >
            <ChevronRight className="size-4" />
          </PhoneStepButton>
          <PhoneStepButton
            label="Last page"
            onGo={page < totalPages ? () => onPage(totalPages) : null}
          >
            <ChevronsRight className="size-4" />
          </PhoneStepButton>
        </nav>
      )}
    </div>
  );
}
