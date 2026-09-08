import { createHash } from "node:crypto";
import type { RouteConfig } from "@x402/core/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  type NewWorkflowPayment,
  organizationWallets,
  type WorkflowPayment,
  workflowPayments,
} from "@/lib/db/schema";
import { railForProtocol } from "@/lib/payments/rails";
import type { CallRouteWorkflow } from "./types";

const X402_RAIL = railForProtocol("x402");

/**
 * Extracts the payer wallet address from a base64-encoded PAYMENT-SIGNATURE
 * header. The x402 protocol encodes the payment payload as base64 JSON with
 * a nested `payload.authorization.from` field (EIP-3009 exact scheme).
 *
 * Returns null when the header is missing or cannot be decoded - payment
 * recording should still succeed, just without the payer address.
 */
export function extractPayerAddress(paymentSig: string | null): string | null {
  if (!paymentSig) {
    return null;
  }
  try {
    const decoded = JSON.parse(
      Buffer.from(paymentSig, "base64").toString("utf-8")
    ) as { payload?: { authorization?: { from?: string } } };
    return decoded?.payload?.authorization?.from ?? null;
  } catch {
    return null;
  }
}

/**
 * Builds the RouteConfig object for withX402().
 * Sets scheme "exact", network Base mainnet, and payTo as the creator wallet.
 * Price is formatted as "$N.NN" -- the dollar sign prefix is required by @x402/evm
 * to parse as USD and resolve the USDC contract automatically.
 * Does NOT set a custom token name to avoid Pitfall 5 (wrong token address resolution).
 */
export function buildPaymentConfig(
  workflow: CallRouteWorkflow,
  creatorWalletAddress: string
): RouteConfig {
  // Passed through at the precision it was stored with. `toFixed(2)` rounded
  // every sub-cent listing to whole cents, while buildPaymentRequired() in
  // ../router.ts advertises the true amount at USDC's six decimals -- so a
  // workflow listed at $0.005 quoted 5000 in its 402 and then demanded 10000 at
  // the gate. The caller signs the advertised amount, the gate finds no
  // requirement matching it, and every payment fails with "No matching payment
  // requirements". @x402/evm parsePrice() resolves "$0.005" to 5000 correctly,
  // so nothing downstream needed the rounding.
  const price = workflow.priceUsdcPerCall ?? "0";
  const publicHost =
    process.env.NEXT_PUBLIC_APP_URL ?? "https://app.keeperhub.com";
  return {
    accepts: {
      scheme: "exact",
      network: X402_RAIL.network,
      payTo: creatorWalletAddress,
      price: `$${price}`,
      // extra.name and extra.version are required by @x402/evm verifyEIP3009 to
      // reconstruct the EIP-712 domain. Without these fields the CDP facilitator
      // throws "EIP-712 domain parameters (name, version) are required" and the
      // payment surfaces as verification-failed for all callers (KEEP-364).
      // Taken from the rail rather than restated, so it and the signer's domain
      // are the same value rather than two literals a comment asks to match.
      extra: { ...X402_RAIL.domain },
    },
    resource: `${publicHost}/api/mcp/workflows/${workflow.listedSlug}/call`,
    description: `Pay to run workflow: ${workflow.name}`,
  };
}

/**
 * Computes a SHA-256 hex digest of the raw PAYMENT-SIGNATURE header value.
 * Used as the idempotency key stored in workflow_payments.payment_hash.
 */
export function hashPaymentSignature(paymentSig: string): string {
  return createHash("sha256").update(paymentSig).digest("hex");
}

/**
 * Looks up an existing payment record by payment hash.
 * Returns the record if found (indicating a duplicate), or null if this is a new payment.
 */
export async function findExistingPayment(
  hash: string
): Promise<WorkflowPayment | null> {
  const rows = await db
    .select()
    .from(workflowPayments)
    .where(eq(workflowPayments.paymentHash, hash))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Connection or open transaction used by recordPayment. Using a Pick of
 * `typeof db` lets the marketplace call route pass either the global
 * `db` or a Drizzle `tx` from `db.transaction(...)` without dragging in
 * the full Drizzle generic surface.
 */
type PaymentRecorderDb = Pick<typeof db, "insert">;

/**
 * Inserts a new payment record into workflow_payments.
 * On Postgres unique violation (code 23505), returns silently --
 * the idempotency check via findExistingPayment handles the response.
 *
 * Accepts an optional connection so the caller can compose this insert
 * with a sibling write (for example flipping `workflow_executions.billable`
 * for KEEP-449) inside a single transaction. Defaults to the global db.
 */
export async function recordPayment(
  data: NewWorkflowPayment,
  conn: PaymentRecorderDb = db
): Promise<void> {
  try {
    await conn.insert(workflowPayments).values(data);
  } catch (err) {
    const cause = (err as { cause?: { code?: string } }).cause;
    if (cause?.code === "23505") {
      return;
    }
    throw err;
  }
}

/**
 * Resolves the creator wallet address for an organization.
 * Returns null when no wallet is registered for the org (workflow cannot accept payment).
 */
export async function resolveCreatorWallet(
  organizationId: string | null
): Promise<string | null> {
  if (organizationId === null) {
    return null;
  }
  const rows = await db
    .select({ walletAddress: organizationWallets.walletAddress })
    .from(organizationWallets)
    .where(
      and(
        eq(organizationWallets.organizationId, organizationId),
        eq(organizationWallets.isActive, true)
      )
    )
    .limit(1);
  return rows[0]?.walletAddress ?? null;
}
