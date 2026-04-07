import { Environment, Para as ParaServer } from "@getpara/server-sdk";
import { eq, isNotNull } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { organizationWallets } from "@/lib/db/schema";
import { decryptUserShare, encryptUserShare } from "@/lib/encryption";
import { authenticateInternalService } from "@/lib/internal-service-auth";
import { ErrorCategory, logSystemError } from "@/lib/logging";

type RefreshResult = {
  organizationId: string | null;
  status: "refreshed" | "failed";
  error?: string;
};

type WalletRow = {
  id: string;
  organizationId: string | null;
  paraSession: string | null;
};

async function refreshWalletSession(
  wallet: WalletRow,
  paraApiKey: string,
  paraEnv: string
): Promise<RefreshResult> {
  // New instance per wallet: importSession mutates internal client state
  const paraClient = new ParaServer(
    paraEnv === "prod" ? Environment.PROD : Environment.BETA,
    paraApiKey
  );

  if (!wallet.paraSession) {
    return {
      organizationId: wallet.organizationId,
      status: "failed",
      error: "No session to refresh",
    };
  }

  const decryptedSession = decryptUserShare(wallet.paraSession);

  await paraClient.importSession(decryptedSession);

  const isActive: boolean = await paraClient.keepSessionAlive();

  if (!isActive) {
    return {
      organizationId: wallet.organizationId,
      status: "failed",
      error: "Session expired, user must re-export",
    };
  }

  const refreshedBlob: string = await paraClient.waitAndExportSession();

  const encryptedRefreshed = encryptUserShare(refreshedBlob);

  await db
    .update(organizationWallets)
    .set({ paraSession: encryptedRefreshed })
    .where(eq(organizationWallets.id, wallet.id));

  return {
    organizationId: wallet.organizationId,
    status: "refreshed",
  };
}

/**
 * GET /api/internal/para-session-refresh
 *
 * Refreshes all stored Para session blobs to prevent expiration.
 * For each wallet with a session: importSession -> keepSessionAlive -> waitAndExportSession -> persist.
 *
 * Intended to be called by an external cron container (Docker/K8s) daily.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const auth = authenticateInternalService(request);
  if (!auth.authenticated) {
    return NextResponse.json(
      { error: auth.error ?? "Unauthorized" },
      { status: 401 }
    );
  }

  const paraApiKey = process.env.PARA_API_KEY;
  const paraEnv = process.env.PARA_ENVIRONMENT ?? "beta";

  if (!paraApiKey) {
    return NextResponse.json(
      { error: "PARA_API_KEY not configured" },
      { status: 500 }
    );
  }

  try {
    const wallets = await db
      .select({
        id: organizationWallets.id,
        organizationId: organizationWallets.organizationId,
        paraSession: organizationWallets.paraSession,
      })
      .from(organizationWallets)
      .where(isNotNull(organizationWallets.paraSession));

    const results: RefreshResult[] = [];

    for (const wallet of wallets) {
      try {
        const result = await refreshWalletSession(wallet, paraApiKey, paraEnv);
        results.push(result);
      } catch (walletError) {
        logSystemError(
          ErrorCategory.INFRASTRUCTURE,
          "[Para] Session refresh failed",
          walletError,
          {
            organizationId: wallet.organizationId ?? "unknown",
            endpoint: "/api/internal/para-session-refresh",
          }
        );
        results.push({
          organizationId: wallet.organizationId,
          status: "failed",
          error:
            walletError instanceof Error
              ? walletError.message
              : "Unknown error",
        });
      }
    }

    const refreshedCount = results.filter(
      (r) => r.status === "refreshed"
    ).length;
    const failedCount = results.filter((r) => r.status === "failed").length;

    return NextResponse.json({
      total: wallets.length,
      refreshedCount,
      failedCount,
      results,
    });
  } catch (error) {
    logSystemError(
      ErrorCategory.DATABASE,
      "[Para] Failed to query wallets for session refresh",
      error,
      { endpoint: "/api/internal/para-session-refresh" }
    );
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to refresh sessions",
      },
      { status: 500 }
    );
  }
}
