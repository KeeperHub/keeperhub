/**
 * GET /api/feedback/[id]
 *
 * Public, unauthenticated endpoint that serves the canonical off-chain
 * feedback JSON referenced by ERC-8004 ReputationRegistry::giveFeedback's
 * `feedbackURI` argument. The `feedbackHash` (bytes32) on-chain is the
 * keccak256 of the bytes returned here, so this content MUST be
 * deterministic and immutable for a given id.
 *
 * The JSON shape is reconstructed from the feedback row + the referenced
 * execution -- not from a stored blob -- because the canonicaliser
 * (lib/agentic-wallet/erc-8004.ts:canonicaliseFeedbackContent) is the
 * source of truth for byte order. Any future field addition there
 * propagates to all historical rows uniformly.
 *
 * Cache-Control: long-lived (mutable rows would invalidate the on-chain
 * hash, so we treat them as immutable). Caches keyed on the id are safe.
 */
import { eq } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";
import {
  buildFeedbackUriContent,
  canonicaliseFeedbackContent,
} from "@/lib/agentic-wallet/erc-8004";
import { db } from "@/lib/db";
import { feedback, workflows } from "@/lib/db/schema";

export const dynamic = "force-dynamic";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id } = await params;
  const rows = await db
    .select({
      id: feedback.id,
      executionId: feedback.executionId,
      workflowId: feedback.workflowId,
      agentChainId: feedback.agentChainId,
      agentId: feedback.agentId,
      payerWallet: feedback.payerWallet,
      value: feedback.value,
      valueDecimals: feedback.valueDecimals,
      comment: feedback.comment,
      createdAt: feedback.createdAt,
      workflowSlug: workflows.listedSlug,
    })
    .from(feedback)
    .leftJoin(workflows, eq(workflows.id, feedback.workflowId))
    .where(eq(feedback.id, id))
    .limit(1);
  const row = rows[0];
  if (!row) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const content = buildFeedbackUriContent({
    agentChainId: row.agentChainId,
    agentId: BigInt(row.agentId),
    clientAddress: row.payerWallet as `0x${string}`,
    createdAt: row.createdAt,
    value: BigInt(row.value),
    valueDecimals: row.valueDecimals,
    comment: row.comment ?? undefined,
    workflowSlug: row.workflowSlug ?? undefined,
    executionId: row.executionId,
  });

  // Serve the canonicalised string (NOT JSON.stringify of `content`) so the
  // bytes match the keccak256 the on-chain feedbackHash committed to.
  const body = canonicaliseFeedbackContent(content);
  return new NextResponse(body, {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "public, max-age=31536000, immutable",
    },
  });
}
