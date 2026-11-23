import { useLayoutEffect, useRef } from "react";

/**
 * Calls `callback` after a render in which `value` changed, never on mount.
 * Runs after the new value is on screen, so the callback can measure or
 * scroll the new layout. The latest callback is used, so callers can pass an
 * inline function without it running on every render.
 */
export function useAfterChange<T>(
  value: T,
  callback: (() => void) | undefined
): void {
  const callbackRef = useRef(callback);
  useLayoutEffect(() => {
    callbackRef.current = callback;
  });

  const shownRef = useRef(value);
  useLayoutEffect(() => {
    if (Object.is(shownRef.current, value)) {
      return;
    }
    shownRef.current = value;
    callbackRef.current?.();
  }, [value]);
}
