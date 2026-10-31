"use client";

import { useCallback, useEffect, useRef } from "react";

// A press this much before the grace began means an event clock on another
// base than performance.now(); it is let through.
const CLOCK_MISMATCH_MS = 60_000;

// The phone drawer's grace after a level change (here for its e2e test).
export const LEVEL_TAP_GRACE_MS = 350;

/**
 * Drops presses on the guarded area (not its portals) made too soon after
 * `start()`, so a double tap's second press misses what the change put there.
 */
export function usePressGrace(
  graceMs: number,
  // Runs at every (re)start; keep it stable (useCallback).
  onStart?: () => void
): {
  start: () => void;
  startThroughNextPaint: () => void;
  inGrace: (timeStamp: number) => boolean;
  onPointerDownCapture: (event: React.PointerEvent) => void;
  onClickCapture: (event: React.MouseEvent) => void;
} {
  const startedAtRef = useRef(Number.NEGATIVE_INFINITY);
  const swallowClickRef = useRef(false);
  const frameRef = useRef<number | null>(null);

  const start = useCallback((): void => {
    startedAtRef.current = performance.now();
    onStart?.();
  }, [onStart]);

  // Again at the frame that paints the change: a busy phone paints late.
  const startThroughNextPaint = useCallback((): void => {
    start();
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current);
    }
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      start();
    });
  }, [start]);

  useEffect(
    () => () => {
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current);
      }
    },
    []
  );

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
      swallowClickRef.current = isOwnTarget(event) && inGrace(event.timeStamp);
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
    // Keyboard clicks (detail 0) are never dropped.
    if (swallow && event.detail > 0 && isOwnTarget(event)) {
      event.preventDefault();
      event.stopPropagation();
    }
  }, []);

  return {
    start,
    startThroughNextPaint,
    inGrace,
    onPointerDownCapture,
    onClickCapture,
  };
}

// React capture events also arrive from portals rendered inside the area.
function isOwnTarget(event: React.SyntheticEvent): boolean {
  return (
    event.target instanceof Node && event.currentTarget.contains(event.target)
  );
}
