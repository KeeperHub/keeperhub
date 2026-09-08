import "server-only";

import { and, eq } from "drizzle-orm";
import { USDC_BASE_ADDRESS } from "@/lib/agentic-wallet/constants";
import { isWalletEmail } from "@/lib/auth/wallet-constants";
import { getPaygSettings } from "@/lib/billing/payg/config-store";
import { getPaygExecutionPriceRaw } from "@/lib/billing/payg/pricing";
import { getPaygTreasuryOrNull } from "@/lib/billing/payg/treasury";
import { usdcRawToDecimal } from "@/lib/billing/payg/usdc";
import type { PlanLimits, PlanName, TierKey } from "@/lib/billing/plans";
import {
  buildQuotaStatus,
  type QuotaStatus,
  type QuotaThreshold,
} from "@/lib/billing/quota-threshold-core";
import { getChainName } from "@/lib/chain-utils";
import { db } from "@/lib/db";
import {
  executionQuotaNotifications,
  member,
  organization,
  users,
} from "@/lib/db/schema";
import {
  type ExecutionQuotaPaygDetails,
  sendExecutionQuotaEmail,
} from "@/lib/email";
import { isAnonymousUser } from "@/lib/is-anonymous";
import { ErrorCategory, logSystemWarn } from "@/lib/logging";
import { getRedis } from "@/lib/redis";
import { quotaNotifyClaimKey } from "@/lib/redis-keys";

/**
 * Delivery side of the execution-quota warning: who gets told, once each, and
 * the record that stops the scan telling them again.
 *
 * The threshold arithmetic itself lives in lib/billing/quota-threshold.ts and
 * is shared with the in-app banner, so the email and the banner can never
 * report different numbers.
 */

/**
 * Owners only. They are the ones who can change the plan or the pay-as-you-go
 * spend caps, which is the entire point of the email.
 */
async function resolveOwnerEmails(organizationId: string): Promise<string[]> {
  const rows = await db
    .select({
      email: users.email,
      emailVerified: users.emailVerified,
      stepUpEmail: users.stepUpEmail,
      name: users.name,
    })
    .from(member)
    .innerJoin(users, eq(users.id, member.userId))
    .where(
      and(eq(member.organizationId, organizationId), eq(member.role, "owner"))
    );

  return [
    ...new Set(
      rows
        .map((row) => deliverableAddress(row))
        .filter((email): email is string => Boolean(email))
    ),
  ];
}

/**
 * The address an owner can actually be reached at, or null.
 *
 * Not every account has a real inbox. Wallet (SIWE) accounts are minted with a
 * synthetic `<address>@wallet.keeperhub.com` login, and anonymous accounts get
 * a placeholder; mailing either is guaranteed to bounce and, on a shared
 * domain, hurts the sending reputation the rest of our mail depends on.
 *
 * So an address only qualifies if the user supplied it and proved they hold it:
 * a wallet owner's enrolled step-up email, which is written only after an
 * emailed code is confirmed, or a verified login email. An owner with neither
 * is skipped, and because the caller does not claim the notification for a
 * skipped org, they are still told once they become reachable.
 */
function deliverableAddress(row: {
  email: string | null;
  emailVerified: boolean | null;
  stepUpEmail: string | null;
  name: string | null;
}): string | null {
  if (isWalletEmail(row.email)) {
    return row.stepUpEmail;
  }
  if (isAnonymousUser({ name: row.name, email: row.email })) {
    return null;
  }
  return row.emailVerified ? row.email : null;
}

/**
 * Record that this org has been told about this threshold for this quota month.
 *
 * Returns false when a row already exists, which is the debounce: an org sitting
 * above 80% for weeks still only gets one email, however often the scan runs.
 * The insert is the claim, so the inline path and the scan cannot both send.
 */
export async function claimQuotaNotification(
  status: QuotaStatus,
  threshold: QuotaThreshold,
  recipientCount: number
): Promise<boolean> {
  const inserted = await db
    .insert(executionQuotaNotifications)
    .values({
      organizationId: status.organizationId,
      periodStart: status.periodStart,
      threshold,
      usagePercent: status.usagePercent,
      executionsUsed: status.used,
      executionLimit: status.limit,
      recipientCount,
    })
    .onConflictDoNothing({
      target: [
        executionQuotaNotifications.organizationId,
        executionQuotaNotifications.periodStart,
        executionQuotaNotifications.threshold,
      ],
    })
    .returning({ id: executionQuotaNotifications.id });

  return inserted.length > 0;
}

export type QuotaNotificationResult = {
  organizationId: string;
  threshold: QuotaThreshold;
  usagePercent: number;
  recipients: number;
};

/**
 * Billing and plans live on the org's own settings pages. Linking straight
 * there skips the /billing redirect and lands the recipient on the right
 * organization even when their last active org was a different one.
 */
function settingsUrls(
  appUrl: string,
  organizationId: string
): { plansUrl: string; billingUrl: string } {
  const org = encodeURIComponent(organizationId);
  return {
    plansUrl: `${appUrl}/settings/${org}/plans`,
    billingUrl: `${appUrl}/settings/${org}/billing`,
  };
}

/**
 * Per-execution price and spend caps as Billing shows them, so the email can
 * quote real figures. Returns null when pay-as-you-go cannot actually charge
 * (no price or no treasury on the settlement chain), since telling someone to
 * top up a wallet that will never be debited would be wrong.
 */
async function resolvePaygDetails(
  organizationId: string
): Promise<ExecutionQuotaPaygDetails | null> {
  const settings = await getPaygSettings(organizationId);
  const priceRaw = getPaygExecutionPriceRaw();

  if (
    priceRaw <= BigInt(0) ||
    getPaygTreasuryOrNull(settings.chainId) === null
  ) {
    return null;
  }

  return {
    priceUsdc: usdcRawToDecimal(priceRaw),
    dailyCapUsdc: usdcRawToDecimal(BigInt(settings.dailyCapRaw)),
    periodCapUsdc: usdcRawToDecimal(BigInt(settings.periodCapRaw)),
    chainName: paygChainName(settings.chainId),
    assetUrl: paygAssetUrl(),
  };
}

/** Base is the only network pay-as-you-go settles on today. */
function paygChainName(chainId: number): string {
  return getChainName(String(chainId));
}

/**
 * Explorer page for the exact USDC contract charges settle against, so a
 * reader can confirm the token themselves instead of matching a symbol.
 * Settlement is always Base USDC regardless of the configured chain, matching
 * the asset the x402 payment is built against.
 */
function paygAssetUrl(): string {
  return `https://basescan.org/token/${USDC_BASE_ADDRESS}`;
}

/**
 * Send one org's quota warning if it has not already been sent this month.
 *
 * Claims before sending, so a delivery failure is not retried into a duplicate
 * on the next run. Returns null when the org is below every threshold,
 * has no reachable owner, or was already notified.
 */
export async function notifyOrgQuotaThreshold(
  status: QuotaStatus,
  appUrl: string
): Promise<QuotaNotificationResult | null> {
  const { threshold } = status;
  if (threshold === null) {
    return null;
  }

  const emails = await resolveOwnerEmails(status.organizationId);
  if (emails.length === 0) {
    // No reachable owner. Leave the claim unmade so a later run can notify once
    // an owner has a deliverable address.
    return null;
  }

  const claimed = await claimQuotaNotification(
    status,
    threshold,
    emails.length
  );
  if (!claimed) {
    return null;
  }

  const [org] = await db
    .select({ name: organization.name })
    .from(organization)
    .where(eq(organization.id, status.organizationId))
    .limit(1);

  const payg = status.paygEligible
    ? await resolvePaygDetails(status.organizationId)
    : null;
  const { plansUrl, billingUrl } = settingsUrls(appUrl, status.organizationId);

  for (const email of emails) {
    await sendExecutionQuotaEmail({
      email,
      orgName: org?.name ?? "Your organization",
      planLabel: status.planLabel,
      threshold,
      used: status.used,
      limit: status.limit,
      usagePercent: status.usagePercent,
      resetDate: status.periodEnd,
      plansUrl,
      billingUrl,
      payg,
      overageRatePerThousand: status.overageRatePerThousand,
    });
  }

  return {
    organizationId: status.organizationId,
    threshold,
    usagePercent: status.usagePercent,
    recipients: emails.length,
  };
}

/** Never hold a cooldown longer than a quota month, even on a clock skew. */
const MAX_COOLDOWN_SECONDS = 32 * 24 * 60 * 60;

/**
 * Whether this process should do the work for (org, period, threshold).
 *
 * Admission runs on every execution, so without this an org over 80% would
 * attempt a DB claim per run for the rest of the month. The Redis `SET NX` is
 * held until the quota resets, so the attempt happens once and the hot path
 * pays a single Redis round trip after that.
 *
 * Returns false when another caller holds it, when Redis is absent, and on a
 * Redis error. With no cooldown authority the inline path stays quiet rather
 * than risking a send per execution; the scheduled scan still catches the org.
 */
async function claimQuotaNotifyCooldown(
  status: QuotaStatus,
  threshold: QuotaThreshold,
  now: Date
): Promise<boolean> {
  const redis = getRedis();
  if (!redis) {
    return false;
  }
  const secondsLeft = Math.ceil(
    (status.periodEnd.getTime() - now.getTime()) / 1000
  );
  const ttl = Math.min(Math.max(secondsLeft, 60), MAX_COOLDOWN_SECONDS);
  try {
    const result = await redis.set(
      quotaNotifyClaimKey(
        status.organizationId,
        status.periodStart.toISOString(),
        threshold
      ),
      "1",
      "EX",
      ttl,
      "NX"
    );
    return result === "OK";
  } catch (error) {
    logSystemWarn(
      ErrorCategory.INFRASTRUCTURE,
      "[QuotaThreshold] cooldown claim failed; leaving it to the scheduled scan",
      error,
      { organization_id: status.organizationId }
    );
    return false;
  }
}

/**
 * Notify on the execution that crosses a threshold, rather than waiting for the
 * next scheduled scan.
 *
 * Fire and forget: admission must not wait on Redis, a recipient lookup or
 * SendGrid, and a failure here must never refuse an execution. Guarded by the
 * cooldown above so the cost on a normal run is one Redis GET-equivalent, and
 * by the same unique row the scan uses so the two paths cannot double send.
 */
export function maybeNotifyQuotaThreshold(params: {
  organizationId: string;
  plan: PlanName;
  tier: TierKey | null;
  planOverrides: Partial<PlanLimits> | null | undefined;
  used: number;
  debtExecutions: number;
}): void {
  const now = new Date();
  const status = buildQuotaStatus({ ...params, now });
  if (!(status && status.threshold !== null)) {
    return;
  }

  const threshold = status.threshold;
  claimQuotaNotifyCooldown(status, threshold, now)
    .then(async (claimed) => {
      if (!claimed) {
        return;
      }
      const appUrl =
        process.env.NEXT_PUBLIC_APP_URL ?? "https://app.keeperhub.com";
      await notifyOrgQuotaThreshold(status, appUrl);
    })
    .catch((error) => {
      logSystemWarn(
        ErrorCategory.EXTERNAL_SERVICE,
        "[QuotaThreshold] inline notification failed; the scheduled scan will retry",
        error,
        { organization_id: params.organizationId }
      );
    });
}
