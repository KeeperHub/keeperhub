"use client";

import {
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import type { PageMeta } from "@/lib/pagination";
import { cn } from "@/lib/utils";

// A step button: first, previous, next or last. With `keepFocus` (the activity
// feed) it is aria-disabled rather than disabled at an end: it turns off as
// soon as it is used there, and a disabled button drops keyboard focus out of
// the pager. Only the icon dims, so a focus ring keeps full strength. Without
// it the button keeps the native disabled the pager always had.
function StepButton({
  children,
  className,
  keepFocus,
  label,
  onGo,
}: {
  children: React.ReactNode;
  className?: string;
  keepFocus: boolean;
  label: string;
  onGo: (() => void) | null;
}): React.ReactElement {
  return (
    <Button
      aria-disabled={keepFocus ? onGo === null : undefined}
      aria-label={label}
      className={cn(
        keepFocus &&
          "aria-disabled:pointer-events-none aria-disabled:[&_svg]:opacity-50",
        className
      )}
      disabled={keepFocus ? undefined : onGo === null}
      onClick={onGo ?? undefined}
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
  compactOnPhones = false,
}: {
  meta: PageMeta;
  onPage: (page: number) => void;
  unit?: string;
  /**
   * Below 640px, swap the numbered window for First/Last around a "Page X of
   * Y" label, and keep focus on spent buttons. The activity feed opts in;
   * other lists keep the pager as it was.
   */
  compactOnPhones?: boolean;
}): React.ReactElement | null {
  const { page, totalPages, total } = meta;
  if (total === 0) {
    return null;
  }

  const compact = compactOnPhones;
  const toFirst = page > 1 ? () => onPage(1) : null;
  const back = page > 1 ? () => onPage(page - 1) : null;
  const forward = page < totalPages ? () => onPage(page + 1) : null;
  const toLast = page < totalPages ? () => onPage(totalPages) : null;

  return (
    // In the compact layout, if the buttons do not fit beside the count they
    // wrap to a row of their own instead of overflowing.
    <div
      className={cn(
        "flex items-center justify-between gap-2",
        compact && "max-sm:flex-wrap max-sm:gap-y-2"
      )}
    >
      <span className="text-muted-foreground text-xs">
        {total} {unit}
      </span>
      {totalPages > 1 && (
        <nav
          aria-label="Pagination"
          className={cn(
            "flex items-center gap-0.5",
            compact && "max-sm:ml-auto"
          )}
        >
          {compact && (
            <StepButton
              className="sm:hidden"
              keepFocus
              label="First page"
              onGo={toFirst}
            >
              <ChevronsLeft className="size-4" />
            </StepButton>
          )}
          <StepButton keepFocus={compact} label="Previous page" onGo={back}>
            <ChevronLeft className="size-4" />
          </StepButton>
          {pageWindow(page, totalPages).map((p, i) =>
            p === "gap" ? (
              <span
                className={cn(
                  "px-1 text-muted-foreground text-xs",
                  compact && "max-sm:hidden"
                )}
                // biome-ignore lint/suspicious/noArrayIndexKey: gaps are positional and static
                key={`gap-${i}`}
              >
                ...
              </span>
            ) : (
              <Button
                aria-current={p === page ? "page" : undefined}
                className={cn("min-w-7", compact && "max-sm:hidden")}
                key={p}
                onClick={() => onPage(p)}
                size="icon-sm"
                variant={p === page ? "default" : "ghost"}
              >
                {p}
              </Button>
            )
          )}
          {compact && (
            // Sized by an invisible copy of the widest label, so the buttons
            // keep their place (and the row its wrap) from page to page.
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
          )}
          <StepButton keepFocus={compact} label="Next page" onGo={forward}>
            <ChevronRight className="size-4" />
          </StepButton>
          {compact && (
            <StepButton
              className="sm:hidden"
              keepFocus
              label="Last page"
              onGo={toLast}
            >
              <ChevronsRight className="size-4" />
            </StepButton>
          )}
        </nav>
      )}
    </div>
  );
}
