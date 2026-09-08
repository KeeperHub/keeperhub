"use client";

import { LayoutGrid, List as ListIcon } from "lucide-react";
import { type KeyboardEvent, useState } from "react";
import { useScrollPreserve } from "./use-scroll-preserve";

type View = "cards" | "list";

type HubViewToggleProps = {
  initialView: View;
  onChange?: (view: View) => void;
};

const ORDER = ["cards", "list"] as const satisfies readonly View[];

export function HubViewToggle({
  initialView,
  onChange,
}: HubViewToggleProps): React.ReactElement {
  const [view, setView] = useState<View>(initialView);
  const preserve = useScrollPreserve();

  const writeCookie = async (next: View): Promise<void> => {
    try {
      await fetch("/api/hub/view", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ view: next }),
      });
    } catch {
      // Cookie write is fire-and-forget; optimistic UI is the source of truth
      // for this session. Next request's first paint will fall back to the
      // previous cookie value if the write fails — acceptable per HUB-19.
    }
  };

  const select = (next: View): void => {
    if (next === view) {
      return;
    }
    preserve(() => {
      setView(next);
      onChange?.(next);
    });
    writeCookie(next).catch(() => {
      // Cookie write is fire-and-forget; ignored — see writeCookie comment.
    });
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    const idx = ORDER.indexOf(view);
    if (e.key === "ArrowRight" || e.key === "ArrowDown") {
      e.preventDefault();
      select(ORDER[(idx + 1) % ORDER.length] as View);
      return;
    }
    if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
      e.preventDefault();
      select(ORDER[(idx - 1 + ORDER.length) % ORDER.length] as View);
      return;
    }
    if (e.key === "Home") {
      e.preventDefault();
      select(ORDER[0]);
      return;
    }
    if (e.key === "End") {
      e.preventDefault();
      const last = ORDER.at(-1);
      if (last !== undefined) {
        select(last);
      }
    }
  };

  const buttonClass = (active: boolean): string =>
    [
      "flex h-8 items-center gap-1.5 rounded-md px-2.5 text-xs transition-colors duration-100 motion-reduce:transition-none",
      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-text-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-hub-card)]",
      active
        ? "bg-[var(--color-bg-accent)] font-semibold text-[var(--color-text-accent)]"
        : "font-normal text-muted-foreground hover:text-foreground",
    ].join(" ");

  return (
    <div
      aria-label="Choose Hub view"
      className="inline-flex shrink-0 gap-0.5 rounded-lg border border-border/30 p-0.5"
      onKeyDown={handleKeyDown}
      role="radiogroup"
    >
      {/* biome-ignore lint/a11y/useSemanticElements: WAI-ARIA radiogroup pattern needs custom radio buttons with icon+label content; native <input type="radio"> cannot host children */}
      <button
        aria-checked={view === "cards"}
        aria-label="View as cards"
        className={buttonClass(view === "cards")}
        onClick={() => select("cards")}
        role="radio"
        tabIndex={view === "cards" ? 0 : -1}
        type="button"
      >
        <LayoutGrid aria-hidden="true" className="size-3.5" />
        Cards
      </button>
      {/* biome-ignore lint/a11y/useSemanticElements: WAI-ARIA radiogroup pattern needs custom radio buttons with icon+label content; native <input type="radio"> cannot host children */}
      <button
        aria-checked={view === "list"}
        aria-label="View as list"
        className={buttonClass(view === "list")}
        onClick={() => select("list")}
        role="radio"
        tabIndex={view === "list" ? 0 : -1}
        type="button"
      >
        <ListIcon aria-hidden="true" className="size-3.5" />
        List
      </button>
    </div>
  );
}
