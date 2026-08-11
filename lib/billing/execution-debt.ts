import "server-only";

import { and, eq, isNull, lt, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { executionDebt, overageBillingRecords } from "@/lib/db/schema";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import type { BillingProvider } from "./provider";
import { getBillingProvider } from "./providers";

const LOG_PREFIX = "[Execution Debt]";
const GRACE_PERIOD_DAYS = 15;

type DebtScanResult = {
  scanned: number;
  created: number;
  skipped: number;
};

type OverageRow = {
  id: string;
  organizationId: string;
  overageCount: number;
  providerInvoiceItemId: string | null;
  providerInvoiceId: string | null;
};

type InvoiceResolution =
  | { resolved: true; invoiceId: string; paid: boolean }
  | { resolved: false };

async function resolveInvoice(
  row: OverageRow & { providerInvoiceItemId: string },
  provider: BillingProvider
): Promise<InvoiceResolution> {
  if (row.providerInvoiceId) {
    const status = await provider.getInvoiceStatus(row.providerInvoiceId);
    return {
      resolved: true,
      invoiceId: row.providerInvoiceId,
      paid: status.paid,
    };
  }

  const invoiceInfo = await provider.getInvoiceForItem(
    row.providerInvoiceItemId
  );
  if (!invoiceInfo) {
    return { resolved: false };
  }

  // Store the invoice ID on the overage record for future lookups
  await db
    .update(overageBillingRecords)
    .set({ providerInvoiceId: invoiceInfo.invoiceId })
    .where(eq(overageBillingRecords.id, row.id));

  return {
    resolved: true,
    invoiceId: invoiceInfo.invoiceId,
    paid: invoiceInfo.paid,
  };
}

/**
 * Scan for unpaid overage records older than 15 days and create debt records.
 * Called by the scheduler daily via the debt-scan API endpoint.
 */
export async function scanAndCreateDebt(): Promise<DebtScanResult> {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - GRACE_PERIOD_DAYS);

  const provider = getBillingProvider();

  // Find billed overage records older than grace period that don't have debt yet
  const rows = await db
    .select({
      id: overageBillingRecords.id,
      organizationId: overageBillingRecords.organizationId,
      overageCount: overageBillingRecords.overageCount,
      providerInvoiceItemId: overageBillingRecords.providerInvoiceItemId,
      providerInvoiceId: overageBillingRecords.providerInvoiceId,
    })
    .from(overageBillingRecords)
    .leftJoin(
      executionDebt,
      eq(executionDebt.overageRecordId, overageBillingRecords.id)
    )
    .where(
      and(
        eq(overageBillingRecords.status, "billed"),
        lt(overageBillingRecords.createdAt, cutoff),
        isNull(executionDebt.id)
      )
    );

  let created = 0;
  let skipped = 0;

  for (const row of rows) {
    if (!row.providerInvoiceItemId) {
      skipped++;
      continue;
    }

    try {
      const invoice = await resolveInvoice(
        { ...row, providerInvoiceItemId: row.providerInvoiceItemId },
        provider
      );
      if (!invoice.resolved || invoice.paid) {
        skipped++;
        continue;
      }

      // Unpaid after grace period -- create debt
      // onConflictDoNothing guards against concurrent scan runs
      const [inserted] = await db
        .insert(executionDebt)
        .values({
          organizationId: row.organizationId,
          overageRecordId: row.id,
          providerInvoiceId: invoice.invoiceId,
          debtExecutions: row.overageCount,
          status: "active",
          enforcedAt: new Date(),
        })
        .onConflictDoNothing()
        .returning({ id: executionDebt.id });

      if (inserted) {
        created++;
      } else {
        skipped++;
      }
    } catch (error: unknown) {
      logSystemError(
        ErrorCategory.BILLING,
        `${LOG_PREFIX} Failed to process overage record`,
        error,
        { overage_record_id: row.id }
      );
      skipped++;
    }
  }

  return { scanned: rows.length, created, skipped };
}

/**
 * Clear all active debt records for a given invoice ID.
 * Called when invoice.paid fires via webhook.
 */
export async function clearDebtForInvoice(invoiceId: string): Promise<number> {
  const result = await db
    .update(executionDebt)
    .set({
      status: "cleared",
      clearedAt: new Date(),
    })
    .where(
      and(
        eq(executionDebt.providerInvoiceId, invoiceId),
        eq(executionDebt.status, "active")
      )
    )
    .returning({ id: executionDebt.id });

  return result.length;
}

/**
 * Clear all active debt records for an organization.
 * Called when a subscription is deleted (debt becomes moot on downgrade to free).
 */
export async function clearAllDebtForOrg(
  organizationId: string
): Promise<number> {
  const result = await db
    .update(executionDebt)
    .set({
      status: "cleared",
      clearedAt: new Date(),
    })
    .where(
      and(
        eq(executionDebt.organizationId, organizationId),
        eq(executionDebt.status, "active")
      )
    )
    .returning({ id: executionDebt.id });

  return result.length;
}

/**
 * Get the total active debt executions for an organization.
 * Used by checkExecutionLimit to reduce the effective monthly limit.
 */
export async function getActiveDebtExecutions(
  organizationId: string
): Promise<number> {
  const result = await db
    .select({
      total: sql<number>`COALESCE(SUM(${executionDebt.debtExecutions}), 0)::int`,
    })
    .from(executionDebt)
    .where(
      and(
        eq(executionDebt.organizationId, organizationId),
        eq(executionDebt.status, "active")
      )
    );

  return result[0]?.total ?? 0;
}
