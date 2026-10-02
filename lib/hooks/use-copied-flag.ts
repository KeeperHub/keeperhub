"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/** How long a copy affordance stays in its "copied" state. */
const COPIED_FOR_MS = 1500;

/**
 * Copy-to-clipboard feedback flag.
 *
 * Five components each declared their own COPIED_FOR_MS and their own
 * useState/setTimeout pair around the identical three lines. None of them
 * cleared the timer, so unmounting inside the window set state on a component
 * that was already gone; this clears it on unmount and on a repeat copy.
 */
export function useCopiedFlag(): [boolean, (text: string) => void] {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) {
        clearTimeout(timer.current);
      }
    },
    []
  );

  const markCopied = useCallback((text: string): void => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    if (timer.current) {
      clearTimeout(timer.current);
    }
    timer.current = setTimeout(() => setCopied(false), COPIED_FOR_MS);
  }, []);

  return [copied, markCopied];
}
