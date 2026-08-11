"use client";

import { useState } from "react";
import { toast } from "sonner";
import { DualFactorSteps } from "@/components/auth/dual-factor-steps";
import { Overlay } from "@/components/overlays/overlay";
import { useOverlay } from "@/components/overlays/overlay-provider";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useSession } from "@/lib/auth-client";
import { handleGuardError } from "@/lib/client/handle-guard-error";
import { ALL, EXPORT_RANGE_OPTIONS } from "@/lib/hooks/use-audit-activity";
import { useDualFactorState } from "@/lib/mfa/use-dual-factor-state";
import {
  downloadAuditExport,
  postAuditExport,
} from "@/lib/security/audit-export";

/**
 * Owner-only, dual-factor (authenticator + email) confirmation for exporting
 * the org audit log. Step 1 picks the window; step 2 is the shared
 * DualFactorSteps challenge. Mirrors the withdraw modal -- the server enforces
 * the same owner + dual-factor gate, this is the matching UX.
 */
export function ExportAuditOverlay({
  overlayId,
  resourceTypes,
}: {
  overlayId: string;
  resourceTypes: string[];
}): React.ReactElement {
  const { pop } = useOverlay();
  const session = useSession();
  const mfaEnrolled =
    (session.data?.user as { twoFactorEnabled?: boolean | null } | undefined)
      ?.twoFactorEnabled === true;
  const dual = useDualFactorState();
  const [range, setRange] = useState<string>(ALL);
  const [step, setStep] = useState<"range" | "mfa">("range");

  const days = range === ALL ? undefined : Number(range);
  const post = (withCodes: boolean): Promise<Response> =>
    postAuditExport({
      days,
      resourceTypes,
      code: withCodes ? dual.totpCode.trim() : undefined,
      emailOtp: withCodes ? dual.emailOtp.trim() || undefined : undefined,
    });

  const startMfa = (): void => {
    if (!mfaEnrolled) {
      toast.error(
        "Enable two-factor authentication in Security settings to export."
      );
      return;
    }
    dual.reset();
    setStep("mfa");
  };

  const handleSubmit = async (): Promise<void> => {
    try {
      const res = await post(true);
      if (!res.ok) {
        if (await handleGuardError(res)) {
          pop();
          return;
        }
        const data = (await res.json()) as { code?: string; error?: string };
        if (dual.handleResponse(data.code, data.error, (m) => toast.error(m))) {
          return;
        }
        throw new Error(data.error ?? "Export failed");
      }
      await downloadAuditExport(res, days);
      toast.success("Audit log exported");
      pop();
    } catch {
      toast.error("Failed to export the audit log");
    }
  };

  const rangeLabel =
    EXPORT_RANGE_OPTIONS.find((o) => o.value === range)?.label ?? "All time";

  if (step === "mfa") {
    return (
      <Overlay overlayId={overlayId} title="Export audit log">
        <DualFactorSteps
          context={
            <>
              Export <strong>{rangeLabel}</strong> of the organization audit log
              {resourceTypes.length > 0
                ? ` (${resourceTypes.length} ${
                    resourceTypes.length === 1 ? "category" : "categories"
                  })`
                : ""}
              .
            </>
          }
          dual={dual}
          onBack={() => setStep("range")}
          onPrefetchEmail={() => dual.prefetchEmail(() => post(false))}
          onResendEmail={() => dual.resendEmail(() => post(false))}
          onSubmit={handleSubmit}
          submitLabel="Export CSV"
        />
      </Overlay>
    );
  }

  return (
    <Overlay
      actions={[
        { label: "Cancel", onClick: pop, variant: "outline" },
        { label: "Continue", onClick: startMfa },
      ]}
      description="Confirm with your authenticator and an emailed code."
      overlayId={overlayId}
      title="Export audit log"
    >
      <div className="space-y-2">
        <span className="font-medium text-sm">Time range</span>
        <Select onValueChange={setRange} value={range}>
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {EXPORT_RANGE_OPTIONS.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-muted-foreground text-xs">
          Exports the current activity filter as CSV.
        </p>
      </div>
    </Overlay>
  );
}
