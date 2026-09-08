"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { DualFactorSteps } from "@/components/auth/dual-factor-steps";
import {
  describeUserAgent,
  relativeTime,
} from "@/components/settings/session-format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { isWalletEmail } from "@/lib/auth/wallet-constants";
import { useSession } from "@/lib/auth-client";
import { useDualFactorState } from "@/lib/mfa/use-dual-factor-state";
import { runWalletStepUp } from "@/lib/wallet/step-up-client";

type SessionRow = {
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

type ListState =
  | { kind: "loading" }
  | { kind: "ready"; rows: SessionRow[] }
  | { kind: "error"; message: string };

export function ActiveSessionsSection(): React.ReactElement {
  const [state, setState] = useState<ListState>({ kind: "loading" });
  const [revokeTarget, setRevokeTarget] = useState<SessionRow | null>(null);
  const [busy, setBusy] = useState(false);
  const [copiedRowId, setCopiedRowId] = useState<string | null>(null);
  const dual = useDualFactorState();
  const session = useSession();
  const isWallet = isWalletEmail(session.data?.user?.email);

  useEffect(() => {
    if (!copiedRowId) {
      return;
    }
    const timer = window.setTimeout(() => setCopiedRowId(null), 2000);
    return () => window.clearTimeout(timer);
  }, [copiedRowId]);

  const handleCopyIp = async (row: SessionRow): Promise<void> => {
    if (!row.ipAddress || typeof navigator === "undefined") {
      return;
    }
    try {
      await navigator.clipboard.writeText(row.ipAddress);
      setCopiedRowId(row.id);
      toast.success("IP copied to clipboard");
    } catch {
      toast.error("Couldn't copy IP");
    }
  };

  const load = useCallback(async (): Promise<void> => {
    setState({ kind: "loading" });
    try {
      const res = await fetch("/api/user/sessions", { cache: "no-store" });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setState({
          kind: "error",
          message: data.error ?? "Couldn't load sessions",
        });
        return;
      }
      const data = (await res.json()) as { sessions: SessionRow[] };
      setState({ kind: "ready", rows: data.sessions });
    } catch (err) {
      setState({
        kind: "error",
        message: err instanceof Error ? err.message : "Couldn't load sessions",
      });
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const closeDialog = useCallback((): void => {
    setRevokeTarget(null);
    dual.reset();
  }, [dual]);

  const handleRevoke = async (): Promise<void> => {
    if (!revokeTarget || busy) {
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`/api/user/sessions/${revokeTarget.id}/revoke`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code: dual.totpCode.trim(),
          emailOtp: dual.emailOtp.trim() || undefined,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        code?: string;
      };
      if (!res.ok) {
        if (
          dual.handleResponse(data.code, data.error, (msg) => toast.error(msg))
        ) {
          return;
        }
        toast.error(data.error ?? "Failed to revoke session");
        return;
      }
      toast.success("Session revoked");
      closeDialog();
      await load();
    } finally {
      setBusy(false);
    }
  };

  const emptyCodesFetch = (): Promise<Response> =>
    fetch(`/api/user/sessions/${revokeTarget?.id ?? ""}/revoke`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

  // Wallet users confirm the revoke by signing the step-up challenge.
  const handleWalletRevoke = async (): Promise<void> => {
    if (!revokeTarget || busy) {
      return;
    }
    setBusy(true);
    try {
      const res = await runWalletStepUp((extra) =>
        fetch(`/api/user/sessions/${revokeTarget.id}/revoke`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(extra),
        })
      );
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        toast.error(data.error ?? "Failed to revoke session");
        return;
      }
      toast.success("Session revoked");
      closeDialog();
      await load();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to revoke session"
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="border-0 py-0 shadow-none">
      <CardContent className="space-y-3 p-0">
        <div className="space-y-1">
          <h3 className="font-medium text-sm">Active sessions</h3>
          <p className="text-muted-foreground text-xs">
            Every device signed in to this account. Revoke any session you don't
            recognise.{" "}
            {isWallet
              ? "Revoking requires a signature from your wallet."
              : "Revoking requires a code from your email and your authenticator."}
          </p>
        </div>

        {state.kind === "loading" && (
          <div className="flex items-center justify-center py-6">
            <Spinner />
          </div>
        )}

        {state.kind === "error" && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-destructive text-xs">
            {state.message}
          </div>
        )}

        {state.kind === "ready" &&
          state.rows.map((row) => {
            const ua = describeUserAgent(row.userAgent);
            const Icon = ua.icon;
            return (
              <div
                className="flex items-start gap-3 rounded-md border bg-muted/30 p-3"
                key={row.id}
              >
                <Icon
                  aria-hidden="true"
                  className="mt-0.5 size-4 text-muted-foreground"
                />
                <div className="flex-1 space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-sm">{ua.label}</span>
                    {row.isCurrent && (
                      <Badge
                        className="h-5 px-1.5 text-[10px]"
                        variant="secondary"
                      >
                        This device
                      </Badge>
                    )}
                  </div>
                  <div className="text-muted-foreground text-xs">
                    {row.ipAddress ? (
                      <button
                        className={`font-mono transition-colors ${
                          copiedRowId === row.id
                            ? "text-emerald-500"
                            : "hover:text-foreground"
                        }`}
                        onClick={() => handleCopyIp(row)}
                        title="Copy IP to clipboard"
                        type="button"
                      >
                        {row.ipAddress}
                      </button>
                    ) : (
                      "IP unknown"
                    )}
                    {row.location ? ` · ${row.location}` : ""}
                  </div>
                  <div className="text-muted-foreground text-xs">
                    Signed in {relativeTime(row.createdAt)} · last active{" "}
                    {relativeTime(row.updatedAt)}
                  </div>
                </div>
                {!row.isCurrent && (
                  <Button
                    onClick={() => {
                      dual.reset();
                      setRevokeTarget(row);
                    }}
                    size="sm"
                    variant="outline"
                  >
                    Revoke
                  </Button>
                )}
              </div>
            );
          })}
      </CardContent>

      <Dialog
        onOpenChange={(next) => {
          if (!next) {
            closeDialog();
          }
        }}
        open={revokeTarget !== null}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Revoke this session</DialogTitle>
            <DialogDescription>
              {revokeTarget
                ? `Sign out ${describeUserAgent(revokeTarget.userAgent).label} (${revokeTarget.ipAddress ?? "unknown IP"}). ${isWallet ? "Sign with your wallet to continue." : "Confirm with both factors to continue."}`
                : null}
            </DialogDescription>
          </DialogHeader>
          {revokeTarget && isWallet && (
            <div className="flex justify-end gap-2">
              <Button onClick={closeDialog} type="button" variant="outline">
                Cancel
              </Button>
              <Button
                disabled={busy}
                onClick={handleWalletRevoke}
                type="button"
                variant="destructive"
              >
                {busy ? <Spinner className="size-4" /> : "Sign to revoke"}
              </Button>
            </div>
          )}
          {revokeTarget && !isWallet && (
            <DualFactorSteps
              busy={busy}
              dual={dual}
              onBack={closeDialog}
              onPrefetchEmail={() => dual.prefetchEmail(emptyCodesFetch)}
              onResendEmail={() => dual.resendEmail(emptyCodesFetch)}
              onSubmit={handleRevoke}
              submitLabel="Revoke session"
              submitVariant="destructive"
            />
          )}
        </DialogContent>
      </Dialog>
    </Card>
  );
}
