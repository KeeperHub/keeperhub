"use client";

import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";

async function fetchSignInURL(
  provider: string,
  callbackURL: string
): Promise<string> {
  const resp = await fetch("/api/auth/sign-in/social", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider, callbackURL }),
    credentials: "include",
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Server error ${resp.status}: ${body}`);
  }

  const data = (await resp.json()) as { url?: string };
  if (!data.url) {
    throw new Error("Server returned no redirect URL.");
  }

  return data.url;
}

function CLIAuthContent(): React.JSX.Element {
  const searchParams = useSearchParams();
  const provider = searchParams.get("provider") ?? "github";
  const port = searchParams.get("port") ?? "";
  const nonce = searchParams.get("nonce") ?? "";
  const [error, setError] = useState("");

  useEffect(() => {
    if (!(port && nonce)) {
      setError("Missing required parameters.");
      return;
    }

    // Use the server-side relay as the OAuth callbackURL so that
    // Better Auth's session cookie (HttpOnly, same domain) can be
    // read and forwarded to the CLI's local callback server.
    // The nonce prevents an attacker from constructing a valid relay URL.
    const relayURL = `${window.location.origin}/api/cli-auth/relay?port=${port}&nonce=${nonce}`;
    let cancelled = false;

    fetchSignInURL(provider, relayURL)
      .then((url) => {
        if (!cancelled) {
          window.location.href = url;
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          const message = err instanceof Error ? err.message : String(err);
          setError(`Failed to connect: ${message}`);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [provider, port, nonce]);

  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm space-y-6 rounded-lg border border-border bg-card p-8 shadow-sm">
        <div className="space-y-1">
          <h1 className="text-xl font-semibold text-foreground">
            CLI Authentication
          </h1>
          {error ? (
            <p className="text-sm text-destructive">{error}</p>
          ) : (
            <p className="text-sm text-muted-foreground">
              Redirecting to authentication provider...
            </p>
          )}
        </div>
      </div>
    </main>
  );
}

export default function CLIAuthPage(): React.JSX.Element {
  return (
    <Suspense>
      <CLIAuthContent />
    </Suspense>
  );
}
