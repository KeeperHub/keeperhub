"use client";

import { ShieldCheck, ShieldOff } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { TotpManageDialog } from "@/components/settings/totp-manage-dialog";
import { TotpSetupDialog } from "@/components/settings/totp-setup-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { isAnonymousUserShape } from "@/lib/auth-anonymous-guard";
import { useSession } from "@/lib/auth-client";

type Status = {
  enabled: boolean;
  name: string | null;
  enrolledAt: string | null;
  hasBackupCodes: boolean;
  anonymous?: boolean;
};

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; status: Status }
  | { kind: "error"; message: string };

function formatDate(iso: string | null): string {
  if (!iso) {
    return "Unknown";
  }
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function TwoFactorSection(): React.ReactElement | null {
  const session = useSession();
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [setupOpen, setSetupOpen] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);

  const sessionUser = session.data?.user as
    | {
        email?: string | null;
        name?: string | null;
        isAnonymous?: boolean | null;
      }
    | undefined;
  const userIsAnonymous = sessionUser
    ? isAnonymousUserShape(sessionUser)
    : false;

  // initialLoad gates the "show only a spinner" branch to the very
  // first /status fetch. Subsequent calls (after enrollment, after
  // disable) refresh state in the background without unmounting the
  // dialogs — otherwise the setup dialog tears down mid-flow, remounts
  // fresh, and its open-effect POSTs /setup again, overwriting the
  // secret the user just enrolled with.
  const [initialLoad, setInitialLoad] = useState(true);

  const loadStatus = useCallback(async (): Promise<void> => {
    try {
      const response = await fetch("/api/user/totp/status");
      if (response.status === 401) {
        setState({ kind: "error", message: "Sign in to manage two-factor." });
        return;
      }
      if (!response.ok) {
        setState({
          kind: "error",
          message: `Status check failed (${response.status})`,
        });
        return;
      }
      const data = (await response.json()) as Status;
      setState({ kind: "ready", status: data });
    } catch (error) {
      setState({
        kind: "error",
        message: error instanceof Error ? error.message : "Network error",
      });
    } finally {
      setInitialLoad(false);
    }
  }, []);

  useEffect(() => {
    if (userIsAnonymous) {
      return;
    }
    loadStatus();
  }, [loadStatus, userIsAnonymous]);

  const handleEnrolled = useCallback((): void => {
    loadStatus();
    session.refetch();
  }, [loadStatus, session]);

  const handleChanged = useCallback((): void => {
    loadStatus();
    session.refetch();
  }, [loadStatus, session]);

  // Anonymous accounts (temp- email / name "Anonymous") cannot enroll
  // TOTP — they have no persistent identity to protect. Hide the
  // section entirely rather than render a disabled card.
  if (userIsAnonymous) {
    return null;
  }

  if (state.kind === "loading" && initialLoad) {
    return (
      <Card>
        <CardContent className="flex items-center gap-3 py-4">
          <Spinner />
          <span className="text-muted-foreground text-sm">
            Loading two-factor status...
          </span>
        </CardContent>
      </Card>
    );
  }

  if (state.kind === "error") {
    return (
      <Card>
        <CardContent className="space-y-3 py-4">
          <p className="text-muted-foreground text-sm">{state.message}</p>
          <Button onClick={loadStatus} size="sm" variant="outline">
            Retry
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (state.kind !== "ready") {
    return null;
  }
  const { status } = state;

  // Status endpoint stamps `anonymous: true` for temp accounts. Belt
  // and braces with the client-side check above.
  if (status.anonymous === true) {
    return null;
  }

  return (
    <>
      <Card>
        <CardContent className="space-y-4 pt-6">
          <div className="flex items-start gap-3">
            {status.enabled ? (
              <ShieldCheck
                aria-hidden="true"
                className="mt-0.5 size-5 shrink-0 text-emerald-500"
              />
            ) : (
              <ShieldOff
                aria-hidden="true"
                className="mt-0.5 size-5 shrink-0 text-muted-foreground"
              />
            )}
            <div className="space-y-1">
              <h3 className="font-medium text-base">
                Two-factor authentication
              </h3>
              {status.enabled ? (
                <p className="text-muted-foreground text-sm">
                  On — {status.name ?? "Authenticator"} (since{" "}
                  {formatDate(status.enrolledAt)})
                </p>
              ) : (
                <p className="text-muted-foreground text-sm">
                  Off. Strongly recommended for accounts that hold wallets or
                  credentials.
                </p>
              )}
            </div>
          </div>
          <div className="flex justify-end">
            {status.enabled ? (
              <Button
                onClick={() => setManageOpen(true)}
                size="sm"
                variant="outline"
              >
                Manage
              </Button>
            ) : (
              <Button onClick={() => setSetupOpen(true)} size="sm">
                Enable
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      <TotpSetupDialog
        onEnrolled={handleEnrolled}
        onOpenChange={setSetupOpen}
        open={setupOpen}
      />

      {status.enabled && (
        <TotpManageDialog
          onChanged={handleChanged}
          onOpenChange={setManageOpen}
          open={manageOpen}
          status={status}
        />
      )}
    </>
  );
}
