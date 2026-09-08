"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { TotpSetupDialog } from "@/components/settings/totp-setup-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { runWalletStepUp, type StepUpExtra } from "@/lib/wallet/step-up-client";

type Enrolled = { wallet: boolean; totp: boolean; email: boolean };

type EnrollmentResponse = {
  walletUser: boolean;
  enrolled: Enrolled;
};

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

  const handleOpenChange = (next: boolean): void => {
    if (!next) {
      setEmail("");
      setCode("");
      setPhase("email");
    }
    onOpenChange(next);
  };

  const send = async (body: Record<string, string>): Promise<Response> =>
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
      handleOpenChange(false);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog onOpenChange={handleOpenChange} open={open}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Add a step-up email</DialogTitle>
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

export function WalletSecuritySection(): React.ReactElement {
  const [data, setData] = useState<EnrollmentResponse | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [setupOpen, setSetupOpen] = useState(false);
  const [addEmailOpen, setAddEmailOpen] = useState(false);

  const load = useCallback(async () => {
    setLoadError(false);
    try {
      const res = await fetch("/api/user/step-up/policy");
      if (res.ok) {
        setData((await res.json()) as EnrollmentResponse);
      } else {
        setLoadError(true);
      }
    } catch {
      setLoadError(true);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const disableEmail = async (): Promise<void> => {
    setBusy(true);
    try {
      const res = await runWalletStepUp((extra: StepUpExtra) =>
        fetch("/api/user/step-up/email", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(extra),
        })
      );
      if (!res.ok) {
        toast.error(await readError(res));
        return;
      }
      toast.success("Step-up email removed.");
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Action failed");
    } finally {
      setBusy(false);
    }
  };

  const disableTotp = async (): Promise<void> => {
    setBusy(true);
    try {
      const res = await runWalletStepUp((extra: StepUpExtra) =>
        fetch("/api/user/totp/disable", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(extra),
        })
      );
      if (!res.ok) {
        toast.error(await readError(res));
        return;
      }
      toast.success("Authenticator disabled.");
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Action failed");
    } finally {
      setBusy(false);
    }
  };

  if (!data) {
    if (loadError) {
      return (
        <div className="py-6 text-center text-muted-foreground text-sm">
          Failed to load security settings.{" "}
          <button
            className="underline"
            onClick={() => {
              load().catch(() => undefined);
            }}
            type="button"
          >
            Retry
          </button>
        </div>
      );
    }
    return (
      <div className="flex justify-center py-6">
        <Spinner className="size-5" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h3 className="font-medium text-sm">Extra confirmation factors</h3>
        <p className="text-muted-foreground text-sm">
          Your wallet signature confirms every sensitive action. Add an
          authenticator or email for extra protection -- once enabled, we ask
          for it on every sensitive action.
        </p>
      </div>

      <Card className="border py-0 shadow-none">
        <CardContent className="flex items-center justify-between gap-4 p-4">
          <div>
            <p className="font-medium text-sm">Authenticator (TOTP)</p>
            <p className="text-muted-foreground text-xs">
              {data.enrolled.totp ? "Enrolled" : "Not set up"}
            </p>
          </div>
          <Switch
            checked={data.enrolled.totp}
            disabled={busy}
            onCheckedChange={(next) => {
              if (next) {
                setSetupOpen(true);
              } else {
                disableTotp();
              }
            }}
          />
        </CardContent>
      </Card>

      <Card className="border py-0 shadow-none">
        <CardContent className="flex items-center justify-between gap-4 p-4">
          <div>
            <p className="font-medium text-sm">Email code</p>
            <p className="text-muted-foreground text-xs">
              {data.enrolled.email ? "Verified email on file" : "Not added"}
            </p>
          </div>
          <Switch
            checked={data.enrolled.email}
            disabled={busy}
            onCheckedChange={(next) => {
              if (next) {
                setAddEmailOpen(true);
              } else {
                disableEmail();
              }
            }}
          />
        </CardContent>
      </Card>

      <TotpSetupDialog
        onEnrolled={load}
        onOpenChange={(next) => {
          setSetupOpen(next);
          if (!next) {
            load();
          }
        }}
        open={setupOpen}
      />
      <AddEmailDialog
        onAdded={load}
        onOpenChange={setAddEmailOpen}
        open={addEmailOpen}
      />
    </div>
  );
}
