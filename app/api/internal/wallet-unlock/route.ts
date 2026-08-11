import { and, eq, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { walletLocks } from "@/lib/db/schema-extensions";
import { authenticateInternalService } from "@/lib/internal-service-auth";
import { ErrorCategory, logSystemError } from "@/lib/logging";

/**
 * POST /api/internal/wallet-unlock
 *
 * KEEP-344: ops escape valve for clearing a held nonce lock without DB
 * access. The wallet_locks TTL self-clears within lockTtlMs and the reaper
 * clears locks for stale executions, so this endpoint is for the rare case
 * where a wallet+chain needs unblocking immediately.
 *
 * Body: { walletAddress: string, chainId: number }
 * Returns: { released: boolean, previousHolder: string | null }
 */
export async function POST(request: Request): Promise<NextResponse> {
  const rawBody = await request.text();
  const auth = await authenticateInternalService(request, rawBody);
  if (!auth.authenticated) {
    return NextResponse.json(
      { error: auth.error ?? "Unauthorized" },
      { status: auth.status }
    );
  }

  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { walletAddress, chainId } = (body ?? {}) as {
    walletAddress?: unknown;
    chainId?: unknown;
  };

  if (typeof walletAddress !== "string" || walletAddress.length === 0) {
    return NextResponse.json(
      { error: "walletAddress is required and must be a string" },
      { status: 400 }
    );
  }

  if (typeof chainId !== "number" || !Number.isInteger(chainId)) {
    return NextResponse.json(
      { error: "chainId is required and must be an integer" },
      { status: 400 }
    );
  }

  const normalizedAddress = walletAddress.toLowerCase();

  try {
    const existing = await db
      .select({
        lockedBy: walletLocks.lockedBy,
        expiresAt: walletLocks.expiresAt,
      })
      .from(walletLocks)
      .where(
        and(
          eq(walletLocks.walletAddress, normalizedAddress),
          eq(walletLocks.chainId, chainId)
        )
      )
      .limit(1);

    const previousHolder = existing[0]?.lockedBy ?? null;

    if (previousHolder === null) {
      return NextResponse.json({ released: false, previousHolder: null });
    }

    // Conditional update: only clear if we observe the same holder we read.
    // If the lock was legitimately released and re-acquired between the
    // SELECT and this UPDATE, the WHERE will fail and we report no release
    // — the operator can re-issue rather than us killing an unrelated holder.
    const released = await db
      .update(walletLocks)
      .set({
        lockedBy: null,
        lockedAt: null,
        expiresAt: sql`NOW()`,
      })
      .where(
        and(
          eq(walletLocks.walletAddress, normalizedAddress),
          eq(walletLocks.chainId, chainId),
          eq(walletLocks.lockedBy, previousHolder)
        )
      )
      .returning({ walletAddress: walletLocks.walletAddress });

    if (released.length === 0) {
      return NextResponse.json({ released: false, previousHolder: null });
    }

    return NextResponse.json({ released: true, previousHolder });
  } catch (error) {
    logSystemError(
      ErrorCategory.DATABASE,
      "Failed to release nonce lock",
      error,
      {
        endpoint: "/api/internal/wallet-unlock",
        operation: "post",
        walletAddress: normalizedAddress,
        chainId: String(chainId),
      }
    );
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to release nonce lock",
      },
      { status: 500 }
    );
  }
}
