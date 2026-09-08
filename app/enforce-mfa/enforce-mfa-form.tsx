"use client";

import { Check, Mail, ShieldCheck, Smartphone } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { TotpSetupDialog } from "@/components/settings/totp-setup-dialog";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { authClient } from "@/lib/auth-client";
import type { StepUpFactor } from "@/lib/mfa/step-up-policy";

type Enrolled = { totp: boolean; email: boolean };

async function readError(response: Response): Promise<string> {
  const data = (await response.json().catch(() => ({}))) as { error?: string };
  return data.error ?? "Something went wrong.";
}

function AddEmailDialog({
  open,
  onOpenChange,
  onAdded,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAdded: () => void;
}): React.ReactElement {
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [phase, setPhase] = useState<"email" | "code">("email");
  const [loading, setLoading] = useState(false);

  const send = (body: Record<string, string>): Promise<Response> =>
    fetch("/api/user/step-up/email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  const requestCode = async (): Promise<void> => {
    setLoading(true);
    try {
      const res = await send({ email: email.trim() });
      if (!res.ok) {
        toast.error(await readError(res));
        return;
      }
      setPhase("code");
      toast.success("Verification code sent.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not send code.");
    } finally {
      setLoading(false);
    }
  };

  const verify = async (): Promise<void> => {
    setLoading(true);
    try {
      const res = await send({ email: email.trim(), code: code.trim() });
      if (!res.ok) {
        toast.error(await readError(res));
        return;
      }
      toast.success("Email added.");
      onAdded();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Verification failed.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Add a verified email</DialogTitle>
          <DialogDescription>
            {phase === "email"
              ? "We'll send a code to confirm this inbox."
              : `Enter the code we sent to ${email}.`}
          </DialogDescription>
        </DialogHeader>
        {phase === "email" ? (
          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              requestCode();
            }}
          >
            <Input
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              required
              type="email"
              value={email}
            />
            <Button disabled={loading} type="submit">
              {loading ? <Spinner className="size-4" /> : "Send code"}
            </Button>
          </form>
        ) : (
          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              verify();
            }}
          >
            <Input
              inputMode="numeric"
              maxLength={6}
              onChange={(e) => setCode(e.target.value)}
              placeholder="123456"
              value={code}
            />
            <Button disabled={loading} type="submit">
              {loading ? <Spinner className="size-4" /> : "Verify"}
            </Button>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function EnforceMfaForm({
  required,
  enrolled,
  orgName,
  otherOrgs,
  next,
}: {
  required: StepUpFactor[];
  enrolled: Enrolled;
  orgName: string;
  otherOrgs: { id: string; name: string }[];
  next: string;
}): React.ReactElement {
  const [totpOpen, setTotpOpen] = useState(false);
  const [emailOpen, setEmailOpen] = useState(false);
  const [leaving, setLeaving] = useState(false);

  const acceptsTotp = required.includes("totp");
  const acceptsEmail = required.includes("email");

  // The gate keys off the active org, so switching to another org (or signing
  // out) is a legitimate way to leave without enrolling. Force a full reload so
  // the proxy re-evaluates compliance against the new active context.
  const switchTo = async (organizationId: string): Promise<void> => {
    setLeaving(true);
    try {
      await authClient.organization.setActive({ organizationId });
      window.location.assign("/");
    } catch {
      toast.error("Could not switch organization.");
      setLeaving(false);
    }
  };

  const signOut = async (): Promise<void> => {
    setLeaving(true);
    try {
      await authClient.signOut();
      window.location.assign("/");
    } catch {
      toast.error("Sign out failed. Please try again.");
      setLeaving(false);
    }
  };

  // A factor was just added. Hard-reload to where they were headed so the proxy
  // re-checks compliance against fresh state (rotated session + flipped flag)
  // and the UI reflects enrollment; if another factor is still required the
  // proxy bounces them back here showing only what's left.
  const onEnrolled = (): void => {
    setTotpOpen(false);
    setEmailOpen(false);
    toast.success("Second factor added.");
    window.location.assign(next);
  };

  return (
    <Card className="w-full max-w-md">
      <CardHeader className="items-center text-center">
        <div className="mb-2 flex size-10 items-center justify-center rounded-full bg-primary/10">
          <ShieldCheck aria-hidden="true" className="size-5 text-primary" />
        </div>
        <CardTitle>Two-factor required</CardTitle>
        <CardDescription>
          {orgName} requires every member to secure their account.{" "}
          {required.length > 1
            ? "Add both factors below to continue."
            : "Add the factor below to continue."}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {acceptsTotp && (
          <button
            className="flex w-full items-center gap-3 rounded-md border bg-muted/30 p-3 text-left transition-colors hover:bg-muted/60 disabled:opacity-60"
            disabled={enrolled.totp}
            onClick={() => setTotpOpen(true)}
            type="button"
          >
            <Smartphone
              aria-hidden="true"
              className="size-5 text-muted-foreground"
            />
            <div className="flex-1">
              <div className="font-medium text-sm">Authenticator app</div>
              <div className="text-muted-foreground text-xs">
                Use an app like 1Password or Google Authenticator.
              </div>
            </div>
            {enrolled.totp ? (
              <Check aria-hidden="true" className="size-4 text-emerald-500" />
            ) : (
              <span className="text-primary text-xs">Set up</span>
            )}
          </button>
        )}
        {acceptsEmail && (
          <button
            className="flex w-full items-center gap-3 rounded-md border bg-muted/30 p-3 text-left transition-colors hover:bg-muted/60 disabled:opacity-60"
            disabled={enrolled.email}
            onClick={() => setEmailOpen(true)}
            type="button"
          >
            <Mail aria-hidden="true" className="size-5 text-muted-foreground" />
            <div className="flex-1">
              <div className="font-medium text-sm">Verified email</div>
              <div className="text-muted-foreground text-xs">
                Receive confirmation codes at an inbox you control.
              </div>
            </div>
            {enrolled.email ? (
              <Check aria-hidden="true" className="size-4 text-emerald-500" />
            ) : (
              <span className="text-primary text-xs">Add</span>
            )}
          </button>
        )}
      </CardContent>

      <CardFooter className="flex-col items-stretch gap-2 border-t pt-4">
        <p className="text-center text-muted-foreground text-xs">
          Don&apos;t want to add a factor? Switch to another organization or
          sign out.
        </p>
        {otherOrgs.map((org) => (
          <Button
            disabled={leaving}
            key={org.id}
            onClick={() => switchTo(org.id)}
            size="sm"
            variant="outline"
          >
            Switch to {org.name}
          </Button>
        ))}
        <Button disabled={leaving} onClick={signOut} size="sm" variant="ghost">
          Sign out
        </Button>
      </CardFooter>

      <TotpSetupDialog
        onEnrolled={onEnrolled}
        onOpenChange={setTotpOpen}
        open={totpOpen}
      />
      <AddEmailDialog
        onAdded={onEnrolled}
        onOpenChange={setEmailOpen}
        open={emailOpen}
      />
    </Card>
  );
}
