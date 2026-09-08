import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import {
  getUserRpcPreferences,
  resolveAllRpcConfigs,
} from "@/lib/rpc/config-service";

export type UserRpcPreferenceResponse = {
  id: string;
  chainId: number;
  primaryRpcUrl: string;
  fallbackRpcUrl: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ResolvedRpcConfigResponse = {
  chainId: number;
  chainName: string;
  primaryRpcUrl: string;
  fallbackRpcUrl: string | null;
  primaryWssUrl: string | null;
  fallbackWssUrl: string | null;
  source: "user" | "default";
};

export type GetUserRpcPreferencesResponse = {
  preferences: UserRpcPreferenceResponse[];
  resolved: ResolvedRpcConfigResponse[];
};

/**
 * GET /api/user/rpc-preferences
 * Get user's RPC preferences and resolved configs for all chains
 */
export async function GET(request: Request) {
  try {
    const session = await auth.api.getSession({
      headers: request.headers,
    });

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const [preferences, resolved] = await Promise.all([
      getUserRpcPreferences(session.user.id),
      resolveAllRpcConfigs(session.user.id),
    ]);

    const response: GetUserRpcPreferencesResponse = {
      preferences: preferences.map((pref) => ({
        id: pref.id,
        chainId: pref.chainId,
        primaryRpcUrl: pref.primaryRpcUrl,
        fallbackRpcUrl: pref.fallbackRpcUrl,
        createdAt: pref.createdAt.toISOString(),
        updatedAt: pref.updatedAt.toISOString(),
      })),
      resolved: resolved.map((config) => ({
        chainId: config.chainId,
        chainName: config.chainName,
        primaryRpcUrl: config.primaryRpcUrl,
        fallbackRpcUrl: config.fallbackRpcUrl ?? null,
        primaryWssUrl: config.primaryWssUrl ?? null,
        fallbackWssUrl: config.fallbackWssUrl ?? null,
        source: config.source,
      })),
    };

    return NextResponse.json(response);
  } catch (error) {
    logSystemError(
      ErrorCategory.DATABASE,
      "Failed to get user RPC preferences",
      error,
      { endpoint: "/api/user/rpc-preferences", operation: "get" }
    );
    return NextResponse.json(
      {
        error: "Failed to get RPC preferences",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
}
