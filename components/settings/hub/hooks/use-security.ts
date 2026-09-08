"use client";

import { useCachedSection } from "./use-cached-section";

export type TotpStatus = {
  enabled: boolean;
  name: string | null;
  enrolledAt: string | null;
  hasBackupCodes: boolean;
};

export type SessionRow = {
  id: string;
  ipAddress: string | null;
  userAgent: string | null;
  country: string | null;
  location: string | null;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  isCurrent: boolean;
};

export type SecurityState = {
  totp: TotpStatus | null;
  totpLoading: boolean;
  sessions: SessionRow[];
  sessionsLoading: boolean;
  reloadTotp: () => Promise<void>;
  reloadSessions: () => Promise<void>;
};

export function useSecurity(): SecurityState {
  const totpState = useCachedSection<TotpStatus | null>(
    "security:totp",
    async () => {
      const res = await fetch("/api/user/totp/status");
      if (!res.ok) {
        throw new Error("Could not load two-factor status");
      }
      return (await res.json()) as TotpStatus;
    }
  );

  const sessionsState = useCachedSection<SessionRow[]>(
    "security:sessions",
    async () => {
      const res = await fetch("/api/user/sessions", { cache: "no-store" });
      if (!res.ok) {
        throw new Error("Could not load sessions");
      }
      const data = (await res.json()) as { sessions?: SessionRow[] };
      return data.sessions ?? [];
    }
  );

  return {
    reloadSessions: sessionsState.refetch,
    reloadTotp: totpState.refetch,
    sessions: sessionsState.data ?? [],
    sessionsLoading: sessionsState.loading,
    totp: totpState.data ?? null,
    totpLoading: totpState.loading,
  };
}
