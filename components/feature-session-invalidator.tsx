"use client";

import { useEffect, useRef } from "react";
import { invalidateFeatureSnapshot } from "@/hooks/use-features";
import { useSession } from "@/lib/auth-client";

export function FeatureSessionInvalidator(): null {
  const { data: session, isPending } = useSession();
  const lastUserIdRef = useRef<string | null | undefined>(undefined);
  const userId = session?.user?.id ?? null;

  useEffect(() => {
    // Wait for the session request to actually resolve. While pending the
    // user id reads as null and would look like a sign-out from the initial
    // undefined sentinel, triggering a spurious invalidate when the real
    // user id arrives a tick later.
    if (isPending) {
      return;
    }
    if (lastUserIdRef.current === undefined) {
      lastUserIdRef.current = userId;
      return;
    }
    if (lastUserIdRef.current !== userId) {
      invalidateFeatureSnapshot();
      lastUserIdRef.current = userId;
    }
  }, [userId, isPending]);

  return null;
}
