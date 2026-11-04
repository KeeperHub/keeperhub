"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type NotificationType =
  | "billing_limit_reached"
  | "workflows_failing"
  | "failure_alerts_unreachable";

type NotificationStatus = {
  unreadCount: number;
  types: NotificationType[];
  /** Alerts are switched on for the org; null until the answer is in. */
  alertsEnabled: boolean | null;
};

const EMPTY_STATUS: NotificationStatus = {
  unreadCount: 0,
  types: [],
  alertsEnabled: null,
};

/**
 * The top banner and the user menu both mount on every page and both want
 * this status. One request answers both: callers within this window share the
 * same response instead of each asking the server.
 */
const SHARE_FOR_MS = 15_000;
const shared = new Map<
  string,
  { at: number; request: Promise<NotificationStatus> }
>();
const subscribers = new Set<(organizationId: string | undefined) => void>();

async function fetchStatus(
  organizationId: string
): Promise<NotificationStatus> {
  try {
    const response = await fetch("/api/notifications/status", {
      credentials: "include",
      headers: { "X-Organization-Id": organizationId },
    });
    // An error says nothing about alerts: unknown, not off.
    if (!response.ok) {
      return EMPTY_STATUS;
    }
    const data = (await response.json()) as Partial<NotificationStatus>;
    return {
      unreadCount: data.unreadCount ?? 0,
      types: data.types ?? [],
      alertsEnabled: data.alertsEnabled === true,
    };
  } catch {
    return EMPTY_STATUS;
  }
}

function loadStatus(
  organizationId: string,
  force: boolean
): Promise<NotificationStatus> {
  const cached = shared.get(organizationId);
  if (!force && cached && Date.now() - cached.at < SHARE_FOR_MS) {
    return cached.request;
  }
  const request = fetchStatus(organizationId);
  const entry = { at: Date.now(), request };
  shared.set(organizationId, entry);
  // A failed answer is not shared: the next caller asks again.
  request
    .then((status) => {
      if (
        status.alertsEnabled === null &&
        shared.get(organizationId) === entry
      ) {
        shared.delete(organizationId);
      }
    })
    .catch(() => undefined);
  return request;
}

/** Drops the cached status and refetches it for every mounted caller (one org, or all). */
export function invalidateNotificationStatus(organizationId?: string): void {
  if (organizationId) {
    shared.delete(organizationId);
  } else {
    shared.clear();
  }
  for (const notify of subscribers) {
    notify(organizationId);
  }
}

export function useNotificationStatus(organizationId?: string | null): {
  status: NotificationStatus;
  refresh: () => Promise<void>;
} {
  const [status, setStatus] = useState<NotificationStatus>(EMPTY_STATUS);
  // Bumped per load and per org change, so a late answer never lands.
  const latest = useRef(0);

  const load = useCallback(
    async (force: boolean): Promise<void> => {
      const ticket = ++latest.current;
      if (!organizationId) {
        setStatus(EMPTY_STATUS);
        return;
      }
      const next = await loadStatus(organizationId, force);
      if (ticket === latest.current) {
        setStatus(next);
      }
    },
    [organizationId]
  );

  useEffect(() => {
    // A new org starts from unknown rather than showing the last org's answer.
    setStatus(EMPTY_STATUS);
    load(false).catch(() => undefined);
    const onInvalidate = (target: string | undefined): void => {
      if (!target || target === organizationId) {
        load(false).catch(() => undefined);
      }
    };
    subscribers.add(onInvalidate);
    return () => {
      subscribers.delete(onInvalidate);
      latest.current += 1;
    };
  }, [load, organizationId]);

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

/** Whether alerts are on for the org: null while unknown, so callers render nothing. */
export function useAlertsEnabled(
  organizationId?: string | null
): boolean | null {
  const { status } = useNotificationStatus(organizationId);
  return organizationId ? status.alertsEnabled : null;
}
