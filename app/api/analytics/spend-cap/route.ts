import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getSpendCapData } from "@/lib/analytics/queries";
import { apiError } from "@/lib/api-error";
import { db } from "@/lib/db";
import { organizationSpendCaps } from "@/lib/db/schema";
import { SCOPE_MCP_READ } from "@/lib/mcp/oauth-scopes";
import { resolveOrganizationId } from "@/lib/middleware/auth-helpers";
import { requirePermission } from "@/lib/middleware/require-org";
import { requireScope } from "@/lib/middleware/require-scope";

const NON_NEGATIVE_INTEGER = /^\d+$/;

export async function GET(request: Request): Promise<Response> {
  const authCtx = await resolveOrganizationId(request);
  if ("error" in authCtx) {
    return NextResponse.json(
      { error: authCtx.error },
      { status: authCtx.status }
    );
  }
  const scopeError = requireScope(authCtx.scope, SCOPE_MCP_READ, {
    credentialType: authCtx.authMethod,
  });
  if (scopeError) {
    return scopeError;
  }

  try {
    const data = await getSpendCapData(authCtx.organizationId);
    return NextResponse.json(data);
  } catch (error: unknown) {
    return apiError(error, "Failed to fetch spend cap data");
  }
}

/**
 * Set or clear the organization's daily value caps.
 *
 * Two independent caps, each optional in the body:
 *   dailyValueCapWei             EVM, wei      (18 decimals)
 *   dailySolanaValueCapLamports  Solana, lamports (9 decimals)
 *
 * An omitted field is left unchanged; an explicit null clears the org's own cap
 * and hands that chain family back to the platform default (there is no
 * uncapped state). Partial updates matter here: the two caps are edited by separate
 * controls, so treating an absent field as "clear" would let saving one cap
 * silently remove the other.
 *
 * Gated by `organization:update` (admin/owner) over the session. A leaked `kh_`
 * API key or MCP OAuth token authenticates a different layer and never satisfies
 * the org session context, so a compromised key cannot raise its own ceiling.
 */
export const PUT = requirePermission(
  "organization",
  ["update"],
  async (req: NextRequest, context): Promise<Response> => {
    const organizationId = context.organization?.id;
    if (!organizationId) {
      return NextResponse.json(
        { error: "Organization not found" },
        { status: 403 }
      );
    }

    let body: {
      dailyValueCapWei?: unknown;
      dailySolanaValueCapLamports?: unknown;
    };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const wei = parseCapField(body, "dailyValueCapWei", "wei");
    if ("error" in wei) {
      return NextResponse.json(wei.error, { status: 400 });
    }
    const lamports = parseCapField(
      body,
      "dailySolanaValueCapLamports",
      "lamports"
    );
    if ("error" in lamports) {
      return NextResponse.json(lamports.error, { status: 400 });
    }

    if (!(wei.present || lamports.present)) {
      return NextResponse.json(
        {
          error:
            "Provide dailyValueCapWei and/or dailySolanaValueCapLamports (null clears a cap)",
        },
        { status: 400 }
      );
    }

    // Only columns explicitly present in the body are written, so updating one
    // cap never clears the other.
    const set: Record<string, unknown> = { updatedAt: new Date() };
    if (wei.present) {
      set.dailyValueCapWei = wei.value;
    }
    if (lamports.present) {
      set.dailySolanaValueCapLamports = lamports.value;
    }

    try {
      await db
        .insert(organizationSpendCaps)
        .values({
          organizationId,
          dailyValueCapWei: wei.present ? wei.value : null,
          dailySolanaValueCapLamports: lamports.present ? lamports.value : null,
        })
        .onConflictDoUpdate({
          target: organizationSpendCaps.organizationId,
          set,
        });
    } catch (error: unknown) {
      return apiError(error, "Failed to update spend cap");
    }

    return NextResponse.json(
      {
        ...(wei.present ? { dailyValueCapWei: wei.value } : {}),
        ...(lamports.present
          ? { dailySolanaValueCapLamports: lamports.value }
          : {}),
      },
      { status: 200 }
    );
  }
);

type CapField =
  | { present: false }
  | { present: true; value: string | null }
  | { error: { error: string; field: string } };

/**
 * Absent -> unchanged, explicit null -> clear, non-negative integer string ->
 * set. Any other shape is rejected rather than coerced, so a malformed cap can
 * never be silently stored as unlimited.
 */
function parseCapField(
  body: Record<string, unknown>,
  field: string,
  unit: string
): CapField {
  if (!(field in body)) {
    return { present: false };
  }
  const raw = body[field];
  if (raw === null) {
    return { present: true, value: null };
  }
  if (typeof raw === "string" && NON_NEGATIVE_INTEGER.test(raw)) {
    return { present: true, value: raw };
  }
  return {
    error: {
      error: `${field} must be a non-negative integer ${unit} string, or null to clear the cap`,
      field,
    },
  };
}
