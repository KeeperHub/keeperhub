import { type MutableRefObject, useEffect, useRef } from "react";

/**
 * Returns a ref that always holds the latest value of `state`.
 * Useful for reading current React state inside Monaco callbacks
 * without re-registering the callback on every state change.
 */
export function useStableRef<T>(state: T): MutableRefObject<T> {
  const ref = useRef(state);
  useEffect(() => {
    ref.current = state;
  }, [state]);
  return ref;
}
