/**
 * POST /api/agentic-wallet/rotate-hmac  (Phase 37 fix #6)
 *
 * HMAC-authenticated rotation of the caller's agentic-wallet HMAC secret.
 * The request is signed with the caller's CURRENT highest-active secret. On
 * success the route mints a new 32-byte (64 hex char) secret at
 * keyVersion + 1, inserts it as the new active row, and stamps every
 * previously-active version with `expires_at = now() + 24h` so clients have
 * a 24-hour grace window to pick up the new secret before old ones stop
 * verifying.
 *
 * Response shape:
 *   200 { newSecret: string, keyVersion: number }
 *   401 { error }                           -- HMAC verification failed
 *   500 { error: "Rotate failed", code: "INTERNAL" }
 *
 * Grace-window stamping is done with a SINGLE UPDATE whose predicate
 * excludes the just-inserted row (`keyVersion != newVersion`) instead of the
 * plan's original two-UPDATE approach. The two-step form would briefly leave
 * the new active row with `expires_at = now + 24h` between the stamp-all and
 * un-stamp steps; a concurrent reader in that window would see the new
 * version as "expiring" even though it's the fresh default. The single
 * UPDATE avoids the transient state entirely.
 *
 * Concurrency: two concurrent rotations for the same sub-org would both read
 * currentVersion simultaneously, both pick newVersion = current + 1, both
 * attempt to insert. The PK constraint (sub_org_id, key_version) resolves
 * this by letting one INSERT win; the other throws and the route returns
 * 500. This is acceptable for a rare, rate-limited rotation (Wave 5 adds
 * rate limiting) — no transactional row-locking is needed today. A future
 * enhancement could wrap the read+insert in db.transaction with SELECT FOR
 * UPDATE if rotation contention ever becomes a real concern.
 */
import { randomBytes } from "node:crypto";
import { and, desc, eq, isNull, ne } from "drizzle-orm";
import { verifyHmacRequest } from "@/lib/agentic-wallet/hmac";
import { insertHmacSecret } from "@/lib/agentic-wallet/hmac-secret-store";
import { db } from "@/lib/db";
import { agenticWalletHmacSecrets } from "@/lib/db/schema";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { buildAuditMetadata, recordAuditEvent } from "@/lib/security/audit-log";

export const dynamic = "force-dynamic";

const GRACE_MS = 24 * 60 * 60 * 1000;
const SECRET_BYTES = 32;

export async function POST(request: Request): Promise<Response> {
  const rawBody = await request.text();
  const auth = await verifyHmacRequest(request, rawBody);
  if (!auth.ok) {
    return Response.json({ error: auth.error }, { status: auth.status });
  }

  try {
    const rows = await db
      .select({ keyVersion: agenticWalletHmacSecrets.keyVersion })
      .from(agenticWalletHmacSecrets)
      .where(eq(agenticWalletHmacSecrets.subOrgId, auth.subOrgId))
      .orderBy(desc(agenticWalletHmacSecrets.keyVersion))
      .limit(1);

    const currentVersion = rows[0]?.keyVersion ?? 0;
    const newVersion = currentVersion + 1;
    const newSecret = randomBytes(SECRET_BYTES).toString("hex");

    // Insert the new active row first so the subsequent grace-window UPDATE
    // can exclude it by keyVersion. insertHmacSecret defaults expiresAt to
    // null, which means "active indefinitely".
    await insertHmacSecret(auth.subOrgId, newVersion, newSecret);

    // Single UPDATE: stamp every prior still-active row with a 24h grace
    // window, excluding the row we just inserted so it stays active.
    const graceUntil = new Date(Date.now() + GRACE_MS);
    await db
      .update(agenticWalletHmacSecrets)
      .set({ expiresAt: graceUntil })
      .where(
        and(
          eq(agenticWalletHmacSecrets.subOrgId, auth.subOrgId),
          isNull(agenticWalletHmacSecrets.expiresAt),
          ne(agenticWalletHmacSecrets.keyVersion, newVersion)
        )
      );

    await recordAuditEvent({
      actor: {
        userId: null,
        organizationId: null,
        authMethod: "internal",
      },
      action: "agentic_wallet.hmac_rotated",
      resourceType: "agentic_wallet",
      resourceId: auth.subOrgId,
      before: { keyVersion: currentVersion },
      after: { keyVersion: newVersion },
      metadata: buildAuditMetadata(request),
    });

    return Response.json(
      { newSecret, keyVersion: newVersion },
      { status: 200 }
    );
  } catch (error) {
    logSystemError(
      ErrorCategory.DATABASE,
      "[Agentic] /rotate-hmac failed",
      error,
      {
        endpoint: "/api/agentic-wallet/rotate-hmac",
        subOrgId: auth.subOrgId,
      }
    );
    return Response.json(
      { error: "Rotate failed", code: "INTERNAL" },
      { status: 500 }
    );
  }
}
