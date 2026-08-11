import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { getChainByChainId } from "@/lib/rpc/chain-service";
import {
  deleteUserRpcPreference,
  resolveRpcConfig,
  setUserRpcPreference,
} from "@/lib/rpc/config-service";
import { assertUrlIsPublic, SsrfBlockedError } from "@/lib/safe-fetch";

export type SetRpcPreferenceRequest = {
  primaryRpcUrl: string;
  fallbackRpcUrl?: string;
};

export type SetRpcPreferenceResponse = {
  id: string;
  chainId: number;
  primaryRpcUrl: string;
  fallbackRpcUrl: string | null;
  createdAt: string;
  updatedAt: string;
};

export type GetRpcConfigResponse = {
  chainId: number;
  chainName: string;
  primaryRpcUrl: string;
  fallbackRpcUrl: string | null;
  primaryWssUrl: string | null;
  fallbackWssUrl: string | null;
  source: "user" | "default";
};

/**
 * GET /api/user/rpc-preferences/:chainId
 * Get the resolved RPC config for a specific chain (user preference or default)
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ chainId: string }> }
) {
  try {
    const session = await auth.api.getSession({
      headers: request.headers,
    });

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { chainId: chainIdStr } = await params;
    const chainId = Number.parseInt(chainIdStr, 10);

    if (Number.isNaN(chainId)) {
      return NextResponse.json({ error: "Invalid chain ID" }, { status: 400 });
    }

    const config = await resolveRpcConfig(chainId, session.user.id);

    if (!config) {
      return NextResponse.json(
        { error: `Chain ${chainId} not found or disabled` },
        { status: 404 }
      );
    }

    const response: GetRpcConfigResponse = {
      chainId: config.chainId,
      chainName: config.chainName,
      primaryRpcUrl: config.primaryRpcUrl,
      fallbackRpcUrl: config.fallbackRpcUrl ?? null,
      primaryWssUrl: config.primaryWssUrl ?? null,
      fallbackWssUrl: config.fallbackWssUrl ?? null,
      source: config.source,
    };

    return NextResponse.json(response);
  } catch (error) {
    logSystemError(ErrorCategory.DATABASE, "Failed to get RPC config", error, {
      endpoint: "/api/user/rpc-preferences/[chainId]",
      operation: "get",
    });
    return NextResponse.json(
      {
        error: "Failed to get RPC config",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
}

/**
 * PUT /api/user/rpc-preferences/:chainId
 * Set or update user's RPC preference for a chain
 */
export async function PUT(
  request: Request,
  { params }: { params: Promise<{ chainId: string }> }
) {
  try {
    const session = await auth.api.getSession({
      headers: request.headers,
    });

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { chainId: chainIdStr } = await params;
    const chainId = Number.parseInt(chainIdStr, 10);

    if (Number.isNaN(chainId)) {
      return NextResponse.json({ error: "Invalid chain ID" }, { status: 400 });
    }

    // Verify chain exists
    const chain = await getChainByChainId(chainId);
    if (!chain) {
      return NextResponse.json(
        { error: `Chain ${chainId} not found` },
        { status: 404 }
      );
    }

    const body: SetRpcPreferenceRequest = await request.json();

    if (!body.primaryRpcUrl) {
      return NextResponse.json(
        { error: "primaryRpcUrl is required" },
        { status: 400 }
      );
    }

    // SSRF guard: reject any URL whose hostname resolves to a private,
    // loopback, link-local, or otherwise reserved address. The persisted
    // URL is later consumed by ethers/Solana/wallet RPC paths, which also
    // route through `safeFetch` for runtime defense-in-depth, but blocking
    // at write time gives a clear 400 to the user instead of an opaque
    // runtime failure later.
    try {
      await assertUrlIsPublic(body.primaryRpcUrl);
      if (body.fallbackRpcUrl) {
        await assertUrlIsPublic(body.fallbackRpcUrl);
      }
    } catch (err) {
      if (err instanceof SsrfBlockedError) {
        return NextResponse.json(
          {
            error: "RPC URL points to a non-public address",
            details: err.message,
          },
          { status: 400 }
        );
      }
      if (err instanceof TypeError) {
        return NextResponse.json(
          { error: "Invalid RPC URL format" },
          { status: 400 }
        );
      }
      // DNS resolution failure
      return NextResponse.json(
        {
          error: "Could not resolve RPC URL host",
          details: err instanceof Error ? err.message : "Unknown error",
        },
        { status: 400 }
      );
    }

    const preference = await setUserRpcPreference(
      session.user.id,
      chainId,
      body.primaryRpcUrl,
      body.fallbackRpcUrl
    );

    const response: SetRpcPreferenceResponse = {
      id: preference.id,
      chainId: preference.chainId,
      primaryRpcUrl: preference.primaryRpcUrl,
      fallbackRpcUrl: preference.fallbackRpcUrl,
      createdAt: preference.createdAt.toISOString(),
      updatedAt: preference.updatedAt.toISOString(),
    };

    return NextResponse.json(response);
  } catch (error) {
    logSystemError(
      ErrorCategory.DATABASE,
      "Failed to set RPC preference",
      error,
      { endpoint: "/api/user/rpc-preferences/[chainId]", operation: "set" }
    );
    return NextResponse.json(
      {
        error: "Failed to set RPC preference",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/user/rpc-preferences/:chainId
 * Remove user's custom RPC preference for a chain (reverts to defaults)
 */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ chainId: string }> }
) {
  try {
    const session = await auth.api.getSession({
      headers: request.headers,
    });

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { chainId: chainIdStr } = await params;
    const chainId = Number.parseInt(chainIdStr, 10);

    if (Number.isNaN(chainId)) {
      return NextResponse.json({ error: "Invalid chain ID" }, { status: 400 });
    }

    const deleted = await deleteUserRpcPreference(session.user.id, chainId);

    if (!deleted) {
      return NextResponse.json(
        { error: "RPC preference not found" },
        { status: 404 }
      );
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    logSystemError(
      ErrorCategory.DATABASE,
      "Failed to delete RPC preference",
      error,
      { endpoint: "/api/user/rpc-preferences/[chainId]", operation: "delete" }
    );
    return NextResponse.json(
      {
        error: "Failed to delete RPC preference",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
}
