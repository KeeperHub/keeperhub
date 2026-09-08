import { NextResponse } from "next/server";
import { findActionSchemaByType } from "@/lib/action-schemas/builder";
import { authenticateApiKey } from "@/lib/api-key-auth";

/**
 * GET /api/action-schemas/{actionType}
 *
 * Returns the schema for a single action, identified by its actionType
 * (e.g. "web3.read-contract", "discord.send-message"). 404 if no such
 * action is registered.
 *
 * Auth: Authorization: Bearer kh_xxxxx (organization API key).
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ actionType: string }> }
): Promise<NextResponse> {
  const auth = await authenticateApiKey(request);
  if (!auth.authenticated) {
    return NextResponse.json(
      { error: auth.error ?? "Unauthorized" },
      { status: auth.statusCode ?? 401 }
    );
  }

  const { actionType: rawActionType } = await context.params;
  const actionType = decodeURIComponent(rawActionType);
  const action = findActionSchemaByType(actionType);

  if (!action) {
    return NextResponse.json(
      { error: `Unknown actionType: ${actionType}` },
      { status: 404 }
    );
  }

  return NextResponse.json(action, {
    headers: {
      "Cache-Control": "private, max-age=300, stale-while-revalidate=600",
    },
  });
}
