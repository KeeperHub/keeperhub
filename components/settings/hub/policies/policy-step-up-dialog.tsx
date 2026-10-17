"use client";

import { useCallback, useState } from "react";
import { toast } from "sonner";
import { DualFactorInput } from "@/components/auth/dual-factor-input";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useDualFactorState } from "@/lib/mfa/use-dual-factor-state";
import { useSettingsContext } from "../settings-context";

/**
 * Confirm it is really you, once, before the first policy change.
 *
 * The server answers a write with `step_up_required` rather than running the
 * challenge inside the write itself, so the person pressed save and is asked to
 * confirm, rather than being asked to prove themselves and then having to press
 * save again. The write that triggered this is replayed on success.
 *
 * The confirmation covers the next ten minutes of policy editing, which is why
 * the dialog says so: somebody who expects to be asked on every save would
 * otherwise read one prompt as a glitch.
 */
export function PolicyStepUpDialog({
  open,
  onCancel,
  onVerified,
}: {
  open: boolean;
  onCancel: () => void;
  onVerified: () => Promise<boolean>;
}): React.ReactElement {
  const { organizationId } = useSettingsContext();
  const dual = useDualFactorState();
  const [submitting, setSubmitting] = useState(false);

  const post = useCallback(
    (body: Record<string, string>) =>
      fetch(`/api/organizations/${organizationId}/policies/step-up`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    [organizationId]
  );

  const submit = useCallback(async () => {
    setSubmitting(true);
    try {
      const res = await post({
        code: dual.totpCode,
        emailOtp: dual.emailOtp,
      });
      const body = (await res.json().catch(() => ({}))) as {
        code?: string;
        error?: string;
        detail?: string;
      };

      // The hook owns the dual-factor outcomes: a first call with no codes
      // mints and emails one, and a wrong code reopens the right field.
      if (
        dual.handleResponse(body.code, body.detail ?? body.error, toast.error)
      ) {
        return;
      }
      if (!res.ok) {
        toast.error(body.detail ?? body.error ?? "Could not confirm it is you");
        return;
      }

      dual.reset();
      await onVerified();
    } catch {
      toast.error("Could not confirm it is you");
    } finally {
      setSubmitting(false);
    }
  }, [dual, onVerified, post]);

  const close = useCallback(() => {
    dual.reset();
    onCancel();
  }, [dual, onCancel]);

  return (
    <Dialog onOpenChange={(next) => !next && close()} open={open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Confirm it is you</DialogTitle>
          <DialogDescription>
            Changing policy changes what your whole organization is allowed to
            do, so it asks once before the first change. The confirmation lasts
            ten minutes, so the rest of this sitting will not ask again.
          </DialogDescription>
        </DialogHeader>

        <DualFactorInput
          awaitingEmailOtp={dual.awaitingEmailOtp}
          disabled={submitting}
          emailOtp={dual.emailOtp}
          idPrefix="policy-step-up"
          onEmailOtpChange={dual.setEmailOtp}
          onTotpChange={dual.setTotpCode}
          totpCode={dual.totpCode}
        />

        <DialogFooter>
          <Button disabled={submitting} onClick={close} variant="ghost">
            Cancel
          </Button>
          <Button
            disabled={submitting || !dual.isReady}
            onClick={() => submit()}
          >
            {submitting ? "Confirming..." : "Confirm"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
