"use client";

import { useEffect } from "react";
import { installPolicyDenialListener } from "@/lib/policy/ui/policy-denial-listener";

/**
 * Mounts the policy refusal listener for the whole app.
 *
 * Renders nothing. It sits beside the other app-wide effects in the root layout
 * so a refusal raised by any request, from any page, says so.
 */
export function PolicyDenialNotifier(): null {
  useEffect(() => {
    installPolicyDenialListener();
  }, []);
  return null;
}
