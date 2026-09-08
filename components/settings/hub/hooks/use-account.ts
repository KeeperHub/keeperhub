"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api-client";
import { useSession } from "@/lib/auth-client";
import { useDualFactorState } from "@/lib/mfa/use-dual-factor-state";
import { useCachedSection } from "./use-cached-section";

type DualFactorState = ReturnType<typeof useDualFactorState>;

export type AccountState = {
  name: string;
  email: string;
  providerId: string | null;
  loading: boolean;
  saving: boolean;
  dirty: boolean;
  /** True when the pending email change needs a TOTP code to go through. */
  showMfaCode: boolean;
  dual: DualFactorState;
  setName: (next: string) => void;
  setEmail: (next: string) => void;
  reset: () => void;
  save: () => Promise<void>;
};

export function useAccount(): AccountState {
  const session = useSession();
  const dual = useDualFactorState();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [savedName, setSavedName] = useState("");
  const [savedEmail, setSavedEmail] = useState("");
  const [providerId, setProviderId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // The account is the same whichever organization is active, so it is cached
  // once and painted from there when a section that needs it opens again.
  const cached = useCachedSection("account:user", () => api.user.get());
  const loading = cached.loading;

  const mfaEnrolled =
    (session.data?.user as { twoFactorEnabled?: boolean | null } | undefined)
      ?.twoFactorEnabled === true;
  const emailChanged = email.trim() !== savedEmail;
  const showMfaCode = mfaEnrolled && emailChanged;

  const refetch = cached.refetch;
  const load = useCallback(async (): Promise<void> => {
    await refetch().catch(() => {
      toast.error("Could not load your account.");
    });
  }, [refetch]);

  const data = cached.data;
  useEffect(() => {
    if (!data) {
      return;
    }
    setName(data.name || "");
    setEmail(data.email || "");
    setSavedName(data.name || "");
    setSavedEmail(data.email || "");
    setProviderId(data.providerId ?? null);
  }, [data]);

  const reset = useCallback((): void => {
    setName(savedName);
    setEmail(savedEmail);
    dual.reset();
  }, [savedName, savedEmail, dual.reset]);

  const save = useCallback(async (): Promise<void> => {
    if (showMfaCode && dual.totpCode.trim().length !== 6) {
      toast.error("Enter the 6-digit code from your authenticator");
      return;
    }
    if (
      showMfaCode &&
      dual.awaitingEmailOtp &&
      dual.emailOtp.trim().length !== 6
    ) {
      toast.error("Enter the 6-digit code we emailed you");
      return;
    }
    setSaving(true);
    try {
      const response = await fetch("/api/user", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          email,
          code: showMfaCode ? dual.totpCode.trim() : undefined,
          emailOtp:
            showMfaCode && dual.emailOtp.trim()
              ? dual.emailOtp.trim()
              : undefined,
        }),
      });
      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as {
          error?: string;
          code?: string;
        };
        if (
          dual.handleResponse(data.code, data.error, (msg) => toast.error(msg))
        ) {
          return;
        }
        throw new Error(data.error ?? "Failed to save settings");
      }
      await load();
      toast.success("Profile saved");
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to save settings"
      );
    } finally {
      setSaving(false);
    }
  }, [name, email, showMfaCode, dual, load]);

  return {
    dirty: emailChanged || name.trim() !== savedName,
    dual,
    email,
    loading,
    name,
    providerId,
    reset,
    save,
    saving,
    setEmail,
    setName,
    showMfaCode,
  };
}
