"use client";

import { AlertTriangle } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { DualFactorSteps } from "@/components/auth/dual-factor-steps";
import { useOverlay } from "@/components/overlays/overlay-provider";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authClient, useSession } from "@/lib/auth-client";
import { useDualFactorState } from "@/lib/mfa/use-dual-factor-state";

type ChangePasswordSectionProps = {
  providerId: string | null;
};

export function ChangePasswordSection({
  providerId,
}: ChangePasswordSectionProps): React.ReactElement | null {
  const router = useRouter();
  const { closeAll: closeOverlays } = useOverlay();
  const session = useSession();
  const sessionUser = session.data?.user as
    | { twoFactorEnabled?: boolean | null }
    | undefined;
  const mfaEnrolled = sessionUser?.twoFactorEnabled === true;
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [phase, setPhase] = useState<"passwords" | "codes">("passwords");
  const dual = useDualFactorState();
  const [loading, setLoading] = useState(false);

  // Wallet (SIWE) accounts have no password -- auth is the wallet itself, so
  // there is nothing to show or manage here.
  if (providerId === "siwe") {
    return null;
  }

  const isOAuthUser = providerId !== null && providerId !== "credential";

  const emptyCodesFetch = (): Promise<Response> =>
    fetch("/api/user/password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ currentPassword, newPassword }),
    });

  const passwordsValid =
    currentPassword.length > 0 &&
    newPassword.length >= 8 &&
    newPassword === confirmPassword;

  const handleSubmit = async (): Promise<void> => {
    setLoading(true);
    try {
      const response = await fetch("/api/user/password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          currentPassword,
          newPassword,
          code: dual.totpCode.trim(),
          emailOtp: dual.emailOtp.trim() || undefined,
        }),
      });

      const data = (await response.json()) as {
        error?: string;
        code?: string;
      };

      if (!response.ok) {
        if (
          dual.handleResponse(data.code, data.error, (msg) => toast.error(msg))
        ) {
          return;
        }
        throw new Error(data.error ?? "Failed to change password");
      }

      await authClient.signOut();
      toast.success("Password changed successfully. Please sign in again.");
      closeOverlays();
      router.push("/");
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to change password"
      );
    } finally {
      setLoading(false);
    }
  };

  if (isOAuthUser) {
    const providerName =
      providerId.charAt(0).toUpperCase() + providerId.slice(1);
    return (
      <Card className="border-0 py-0 shadow-none">
        <CardContent className="p-0">
          <div className="space-y-2">
            <Label className="ml-1">Password</Label>
            <p className="text-muted-foreground text-sm">
              Your password is managed by {providerName}. To change your
              password, please visit your {providerName} account settings.
            </p>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (phase === "codes") {
    return (
      <Card className="border-0 py-0 shadow-none">
        <CardContent className="p-0">
          <Alert variant="default">
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription>
              Confirm with both factors. You will be signed out after the
              password change.
            </AlertDescription>
          </Alert>
          <div className="pt-4">
            <DualFactorSteps
              busy={loading}
              dual={dual}
              onBack={() => setPhase("passwords")}
              onPrefetchEmail={() => dual.prefetchEmail(emptyCodesFetch)}
              onResendEmail={() => dual.resendEmail(emptyCodesFetch)}
              onSubmit={handleSubmit}
              submitLabel="Change password"
            />
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="border-0 py-0 shadow-none">
      <CardContent className="p-0">
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!mfaEnrolled) {
              toast.error("Enable two-factor authentication first");
              return;
            }
            if (!passwordsValid) {
              if (newPassword !== confirmPassword) {
                toast.error("New passwords do not match");
              } else if (newPassword.length < 8) {
                toast.error("Password must be at least 8 characters");
              } else {
                toast.error("Enter your current and new password");
              }
              return;
            }
            setPhase("codes");
          }}
        >
          <Alert variant="default">
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription>
              You will be signed out after changing your password and will need
              to sign in again.
            </AlertDescription>
          </Alert>

          <div className="space-y-2">
            <Label className="ml-1" htmlFor="currentPassword">
              Current Password
            </Label>
            <Input
              autoComplete="current-password"
              id="currentPassword"
              onChange={(e) => setCurrentPassword(e.target.value)}
              placeholder="Enter current password"
              required
              type="password"
              value={currentPassword}
            />
          </div>

          <div className="space-y-2">
            <Label className="ml-1" htmlFor="newPassword">
              New Password
            </Label>
            <Input
              autoComplete="new-password"
              id="newPassword"
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="Enter new password (min 8 characters)"
              required
              type="password"
              value={newPassword}
            />
          </div>

          <div className="space-y-2">
            <Label className="ml-1" htmlFor="confirmPassword">
              Confirm New Password
            </Label>
            <Input
              autoComplete="new-password"
              id="confirmPassword"
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="Confirm new password"
              required
              type="password"
              value={confirmPassword}
            />
          </div>

          <Button
            className="w-full"
            disabled={loading || !passwordsValid}
            type="submit"
          >
            Continue
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
