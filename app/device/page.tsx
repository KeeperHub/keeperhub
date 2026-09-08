"use client";

import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { AuthDialog } from "@/components/auth/dialog";
import { claimAndApproveDevice } from "@/lib/device-authorization-client";
import { isAnonymousUser } from "@/lib/is-anonymous";

function SuccessState(): React.JSX.Element {
  return (
    <p className="text-sm font-medium text-foreground">
      Device authorized. You may close this window and return to your CLI.
    </p>
  );
}

function ErrorState({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}): React.JSX.Element {
  return (
    <div className="space-y-3">
      <p className="text-sm text-destructive">{message}</p>
      <button
        className="w-full rounded-md border border-border bg-background px-4 py-2 text-sm font-medium text-foreground hover:bg-muted"
        onClick={onRetry}
        type="button"
      >
        Try Again
      </button>
    </div>
  );
}

function LoadingState(): React.JSX.Element {
  return (
    <button
      className="w-full rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground opacity-50"
      disabled
      type="button"
    >
      Confirming...
    </button>
  );
}

function IdleState({
  userCode,
  onConfirm,
}: {
  userCode: string;
  onConfirm: () => void;
}): React.JSX.Element {
  return (
    <button
      className="w-full rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
      disabled={!userCode}
      onClick={onConfirm}
      type="button"
    >
      Confirm
    </button>
  );
}

export default function DevicePage(): React.JSX.Element {
  return (
    <Suspense>
      <DevicePageContent />
    </Suspense>
  );
}

function DevicePageContent(): React.JSX.Element {
  const searchParams = useSearchParams();
  const userCode = searchParams.get("user_code") ?? "";
  const [status, setStatus] = useState<
    "idle" | "loading" | "success" | "error"
  >("idle");
  const [errorMessage, setErrorMessage] = useState("");
  const [isAuthenticated, setIsAuthenticated] = useState<boolean | null>(null);

  useEffect(() => {
    async function checkSession(): Promise<void> {
      const res = await fetch("/api/auth/get-session", {
        credentials: "include",
      });
      if (res.ok) {
        const data = (await res.json().catch(() => null)) as {
          session?: unknown;
          user?: { name?: string | null; email?: string | null } | null;
        } | null;
        const hasSession = Boolean(data?.session);
        setIsAuthenticated(hasSession && !isAnonymousUser(data?.user));
      } else {
        setIsAuthenticated(false);
      }
    }
    checkSession();

    const onFocus = (): void => {
      checkSession();
    };
    window.addEventListener("focus", onFocus);

    const interval = setInterval(checkSession, 2000);

    return () => {
      window.removeEventListener("focus", onFocus);
      clearInterval(interval);
    };
  }, []);

  const handleConfirm = async (): Promise<void> => {
    setStatus("loading");
    const result = await claimAndApproveDevice(userCode);

    if (result.ok) {
      setStatus("success");
      return;
    }

    setErrorMessage(result.message);
    setStatus("error");
  };

  const renderAction = (): React.JSX.Element => {
    if (isAuthenticated === null) {
      return (
        <button
          className="w-full rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground opacity-50"
          disabled
          type="button"
        >
          Checking session...
        </button>
      );
    }
    if (isAuthenticated === false) {
      return (
        <AuthDialog>
          <button
            className="w-full rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
            type="button"
          >
            Sign in to authorize
          </button>
        </AuthDialog>
      );
    }
    if (status === "success") {
      return <SuccessState />;
    }
    if (status === "error") {
      return (
        <ErrorState message={errorMessage} onRetry={() => setStatus("idle")} />
      );
    }
    if (status === "loading") {
      return <LoadingState />;
    }
    return <IdleState onConfirm={handleConfirm} userCode={userCode} />;
  };

  return (
    <main className="pointer-events-auto flex min-h-screen flex-col items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm space-y-6 rounded-lg border border-border bg-card p-8 shadow-sm">
        <div className="space-y-1">
          <h1 className="text-xl font-semibold text-foreground">
            Device Authorization
          </h1>
          <p className="text-sm text-muted-foreground">
            Confirm the code below matches what your CLI displays.
          </p>
        </div>

        {userCode ? (
          <div className="rounded-md bg-muted px-4 py-3 text-center">
            <span className="font-mono text-2xl font-bold tracking-widest text-foreground">
              {userCode}
            </span>
          </div>
        ) : (
          <p className="text-sm text-destructive">
            No code provided. Please return to your CLI and try again.
          </p>
        )}

        {renderAction()}
      </div>
    </main>
  );
}
