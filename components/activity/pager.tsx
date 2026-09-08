"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { PageMeta } from "@/lib/pagination";

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
    <div className="flex items-center justify-between gap-2">
      <span className="text-muted-foreground text-xs">
        {total} {unit}
      </span>
      {totalPages > 1 && (
        <nav aria-label="Pagination" className="flex items-center gap-0.5">
          <Button
            aria-label="Previous page"
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
                className="px-1 text-muted-foreground text-xs"
                // biome-ignore lint/suspicious/noArrayIndexKey: gaps are positional and static
                key={`gap-${i}`}
              >
                ...
              </span>
            ) : (
              <Button
                aria-current={p === page ? "page" : undefined}
                className="min-w-7"
                key={p}
                onClick={() => onPage(p)}
                size="icon-sm"
                variant={p === page ? "default" : "ghost"}
              >
                {p}
              </Button>
            )
          )}
          <Button
            aria-label="Next page"
            disabled={page >= totalPages}
            onClick={() => onPage(page + 1)}
            size="icon-sm"
            variant="ghost"
          >
            <ChevronRight className="size-4" />
          </Button>
        </nav>
      )}
    </div>
  );
}
