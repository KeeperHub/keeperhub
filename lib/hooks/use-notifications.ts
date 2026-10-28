"use client";

import { useCallback, useEffect, useState } from "react";

export type NotificationType =
  | "billing_limit_reached"
  | "workflows_failing"
  | "failure_alerts_unreachable";

type NotificationStatus = {
  unreadCount: number;
  types: NotificationType[];
};

const EMPTY_STATUS: NotificationStatus = { unreadCount: 0, types: [] };

/**
 * The top banner and the user menu both mount on every page and both want
 * this status. One request answers both: callers within this window share the
 * same response instead of each asking the server.
 */
const SHARE_FOR_MS = 15_000;
let shared: {
  organizationId: string;
  at: number;
  request: Promise<NotificationStatus>;
} | null = null;

async function fetchStatus(): Promise<NotificationStatus> {
  try {
    const response = await fetch("/api/notifications/status", {
      credentials: "include",
    });
    if (!response.ok) {
      return EMPTY_STATUS;
    }
    const data = (await response.json()) as NotificationStatus;
    return { unreadCount: data.unreadCount ?? 0, types: data.types ?? [] };
  } catch {
    return EMPTY_STATUS;
  }
}

function loadStatus(
  organizationId: string,
  force: boolean
): Promise<NotificationStatus> {
  const fresh =
    shared &&
    shared.organizationId === organizationId &&
    Date.now() - shared.at < SHARE_FOR_MS;
  if (!force && fresh && shared) {
    return shared.request;
  }
  shared = { organizationId, at: Date.now(), request: fetchStatus() };
  return shared.request;
}

export function useNotificationStatus(organizationId?: string | null): {
  status: NotificationStatus;
  refresh: () => Promise<void>;
} {
  const [status, setStatus] = useState<NotificationStatus>(EMPTY_STATUS);

  const load = useCallback(
    async (force: boolean): Promise<void> => {
      if (!organizationId) {
        setStatus(EMPTY_STATUS);
        return;
      }
      setStatus(await loadStatus(organizationId, force));
    },
    [organizationId]
  );

  useEffect(() => {
    load(false).catch(() => undefined);
  }, [load]);

  // An explicit refresh (opening the user menu) always asks again.
  const refresh = useCallback(() => load(true), [load]);

  return { status, refresh };
}

export function hasNotificationType(
  status: NotificationStatus,
  type: NotificationType
): boolean {
  return status.types.includes(type);
}
