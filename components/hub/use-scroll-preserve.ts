"use client";

import { useLayoutEffect, useRef } from "react";

/**
 * Captures window.scrollY before a re-render and synchronously restores it
 * inside useLayoutEffect — ensures view-mode swaps don't jump scroll position
 * (HUB-21). The effect runs on every render so the restore happens immediately
 * after the state-change render. The captured value is reset after restore so
 * subsequent unrelated renders don't re-scroll.
 *
 * Usage:
 *   const preserve = useScrollPreserve();
 *   const handleToggle = (next: View) => preserve(() => setView(next));
 */
export function useScrollPreserve(): (run: () => void) => void {
  const targetY = useRef<number | null>(null);

  useLayoutEffect(() => {
    if (targetY.current !== null && typeof window !== "undefined") {
      window.scrollTo(0, targetY.current);
      targetY.current = null;
    }
  });

  return (run: () => void): void => {
    if (typeof window !== "undefined") {
      targetY.current = window.scrollY;
    }
    run();
  };
}
