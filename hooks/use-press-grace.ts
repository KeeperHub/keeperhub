"use client";

import { useCallback, useRef } from "react";

// A press this much before the grace began means an event clock on another
// base than performance.now(); it is let through.
const CLOCK_MISMATCH_MS = 60_000;

/**
 * Drops presses made too soon after `start()` (or before it, still queued):
 * the second tap of a double tap would otherwise land on whatever the change
 * put under the finger. The capture handlers go on the area to guard; a
 * dropped press neither focuses nor opens anything (Radix skips prevented
 * presses) and its click is dropped. Keyboard clicks (detail 0) never are.
 */
export function usePressGrace(graceMs: number): {
  start: () => void;
  inGrace: (timeStamp: number) => boolean;
  onPointerDownCapture: (event: React.PointerEvent) => void;
  onClickCapture: (event: React.MouseEvent) => void;
} {
  const startedAtRef = useRef(Number.NEGATIVE_INFINITY);
  const swallowClickRef = useRef(false);

  const start = useCallback((): void => {
    startedAtRef.current = performance.now();
  }, []);

  // Capped at now, should a browser stamp events late or on another clock.
  const inGrace = useCallback(
    (timeStamp: number): boolean => {
      const pressedAt = Math.min(timeStamp, performance.now());
      const early = startedAtRef.current + graceMs - pressedAt;
      return early > 0 && early < CLOCK_MISMATCH_MS;
    },
    [graceMs]
  );

  const onPointerDownCapture = useCallback(
    (event: React.PointerEvent): void => {
      swallowClickRef.current = inGrace(event.timeStamp);
      if (swallowClickRef.current) {
        event.preventDefault();
      }
    },
    [inGrace]
  );

  // Each press judges one click; a click without a press goes through.
  const onClickCapture = useCallback((event: React.MouseEvent): void => {
    const swallow = swallowClickRef.current;
    swallowClickRef.current = false;
    if (swallow && event.detail > 0) {
      event.preventDefault();
      event.stopPropagation();
    }
  }, []);

  return { start, inGrace, onPointerDownCapture, onClickCapture };
}
