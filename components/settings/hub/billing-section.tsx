"use client";

import Link from "next/link";
import { BillingDetails } from "@/components/billing/billing-details";
import { BillingHistory } from "@/components/billing/billing-history";
import { PaygSection } from "@/components/billing/payg-section";
import { Button } from "@/components/ui/button";
import { PAYG_PLAN_NAME } from "@/lib/billing/plans";
import { UsageMeter } from "./billing/usage-meter";
import { useBillingSummary } from "./hooks/use-billing-summary";
import { EmptyState, SectionHeader, SettingsCard, StatTile } from "./section";
import { useSettingsContext } from "./settings-context";
import { FormSkeleton } from "./skeletons";

/** Provider statuses arrive lower-case and underscored, e.g. `past_due`. */
const STATUS_LABELS: Record<string, string> = {
  active: "Active",
  canceled: "Canceled",
  incomplete: "Incomplete",
  incomplete_expired: "Expired",
  past_due: "Past due",
  paused: "Paused",
  trialing: "Trialing",
  unpaid: "Unpaid",
};

function statusLabel(status: string | undefined): string {
  if (!status) {
    return "";
  }
  return STATUS_LABELS[status] ?? status.replace(/_/g, " ");
}

const PLAN_LABELS: Record<string, string> = {
  business: "Business",
  enterprise: "Enterprise",
  free: "Free",
  pro: "Pro",
};

function formatDate(value: string | null): string {
  return value ? new Date(value).toLocaleDateString() : "--";
}

/** Only the owner can act on a plan, so everyone else is offered a look. */
function changePlanLabel(isOwner: boolean, isPaid: boolean): string {
  if (!isOwner) {
    return "View plans";
  }
  return isPaid ? "Change plan" : "Upgrade";
}

export function BillingSection(): React.ReactElement {
  const { organizationId, isOwner } = useSettingsContext();
  const { summary, loading } = useBillingSummary();
  const isPaid = summary ? summary.plan !== "free" : false;
  const pending = loading || !summary;

  return (
    <>
      <SectionHeader
        action={
          <Button asChild>
            <Link href={`/settings/${organizationId}/plans`}>
              {changePlanLabel(isOwner, isPaid)}
            </Link>
          </Button>
        }
        description="What this organization is on right now, and how much of it you have used this month."
        title="Billing"
      />

      <div className="grid gap-4 sm:grid-cols-3">
        <StatTile
          hint={summary?.interval ? `Billed ${summary.interval}` : "No charge"}
          label="Current plan"
          loading={pending}
          value={summary ? (PLAN_LABELS[summary.plan] ?? summary.plan) : ""}
        />
        <StatTile
          hint={
            summary?.cancelAtPeriodEnd
              ? "Cancels at period end"
              : `Renews ${formatDate(summary?.renewsAt ?? null)}`
          }
          label="Status"
          loading={pending}
          tone={summary?.cancelAtPeriodEnd ? "warning" : "neutral"}
          value={statusLabel(summary?.status)}
        />
        <StatTile
          hint="Billable runs this calendar month"
          label="Executions used"
          loading={pending}
          value={summary?.executionsUsed.toLocaleString() ?? ""}
        />
      </div>

      <SettingsCard
        description="Resets at the start of each calendar month."
        title="This month"
      >
        {loading || !summary ? (
          <FormSkeleton rows={2} />
        ) : (
          <div className="flex flex-col gap-5">
            <UsageMeter
              format={(v) => v.toLocaleString()}
              hint="Counts billable executions only."
              label="Executions"
              total={summary.executionLimit}
              used={summary.executionsUsed}
            />
            {summary.gasTotalCents > 0 && (
              <UsageMeter
                format={(v) => `$${(v / 100).toFixed(2)}`}
                hint="Gas sponsored by KeeperHub on supported networks."
                label="Gas sponsorship credits"
                total={summary.gasTotalCents}
                used={summary.gasUsedCents}
              />
            )}
          </div>
        )}
      </SettingsCard>

      {isPaid && isOwner && (
        <>
          {/* One under the other, each the full width: side by side left the
              history table too narrow to show its first column. */}
          <BillingDetails />
          <BillingHistory />
        </>
      )}

      {isPaid && !isOwner && (
        <SettingsCard title="Payment and invoices">
          <EmptyState>
            The card on file and the invoices are visible to the owner of this
            organization only.
          </EmptyState>
        </SettingsCard>
      )}

      {summary?.plan === PAYG_PLAN_NAME && (
        <SettingsCard
          description="Keep a balance in USDC and spend it per execution, with no subscription. Top it up here."
          title="Pay as you go"
        >
          <PaygSection canManageCaps={isOwner} plan={summary.plan} />
        </SettingsCard>
      )}
    </>
  );
}
