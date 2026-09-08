"use client";

import { useCallback, useEffect, useState } from "react";

export type NotificationType = "billing_limit_reached";

type NotificationStatus = {
  unreadCount: number;
  types: NotificationType[];
};

const EMPTY_STATUS: NotificationStatus = { unreadCount: 0, types: [] };

export function useNotificationStatus(organizationId?: string | null): {
  status: NotificationStatus;
  refresh: () => Promise<void>;
} {
  const [status, setStatus] = useState<NotificationStatus>(EMPTY_STATUS);

  const refresh = useCallback(async (): Promise<void> => {
    if (!organizationId) {
      setStatus(EMPTY_STATUS);
      return;
    }
    try {
      const response = await fetch("/api/notifications/status", {
        credentials: "include",
      });
      if (!response.ok) {
        setStatus(EMPTY_STATUS);
        return;
      }
      const data = (await response.json()) as NotificationStatus;
      setStatus({
        unreadCount: data.unreadCount ?? 0,
        types: data.types ?? [],
      });
    } catch {
      setStatus(EMPTY_STATUS);
    }
  }, [organizationId]);

  useEffect(() => {
    refresh().catch(() => undefined);
  }, [refresh]);

  return { status, refresh };
}

export function hasNotificationType(
  status: NotificationStatus,
  type: NotificationType
): boolean {
  return status.types.includes(type);
}
