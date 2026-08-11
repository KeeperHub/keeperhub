/**
 * POST /api/agentic-wallet/feedback
 *
 * HMAC-authenticated entry point that lets a caller wallet submit ERC-8004
 * feedback for a workflow execution it paid for. The route is the
 * orchestrator: it builds the off-chain feedback JSON, computes its
 * keccak256 hash, encodes the giveFeedback() call, signs the unsigned EVM
 * tx via Turnkey (policy-gated to ReputationRegistry::giveFeedback on
 * Ethereum mainnet only), and broadcasts via the configured eth-mainnet
 * RPC. Returns the new feedback row id, on-chain tx hash, and the public
 * URL of the canonical feedback JSON (the feedbackURI committed on-chain).
 *
 * Request body:
 *   {
 *     executionId: string,         // workflow_executions.id
 *     value: string | number,      // raw int128 (string for safety)
 *     valueDecimals: number,       // 0..18
 *     comment?: string,            // optional, surfaced in feedbackURI JSON
 *     agentChainId?: number,       // default 1 (Ethereum mainnet)
 *     agentId?: string,            // default KEEPERHUB_ERC_8004_AGENT_ID
 *   }
 *
 * Response:
 *   200 { feedbackId, txHash, publicUrl }
 *   400 BAD_INPUT
 *   401 missing/invalid HMAC
 *   402 INSUFFICIENT_GAS -- caller's wallet cannot cover mainnet gas
 *   403 NOT_PAYER  -- caller's wallet did not pay for the referenced execution
 *   404 EXECUTION_NOT_FOUND
 *   409 ALREADY_RATED -- caller already rated this execution
 *   502 TURNKEY_UPSTREAM | RPC_UPSTREAM
 *
 * Anti-spam: payerAddress on the workflow_payments row must match the
 * caller's wallet address. ERC-8004 contract itself blocks self-feedback
 * (agent owner can't rate themselves) -- we don't replicate that gate
 * here, the chain enforces it.
 */
import { and, eq } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";
import { createPublicClient, type Hex, http, serializeTransaction } from "viem";
import { mainnet } from "viem/chains";
import {
  ERC_8004_REPUTATION_REGISTRY_ADDRESS,
  ETHEREUM_MAINNET_CHAIN_ID,
  KEEPERHUB_ERC_8004_AGENT_ID,
} from "@/lib/agentic-wallet/constants";
import {
  buildFeedbackUriContent,
  buildGiveFeedbackCalldata,
  hashFeedbackContent,
} from "@/lib/agentic-wallet/erc-8004";
import { verifyHmacRequest } from "@/lib/agentic-wallet/hmac";
import {
  PolicyBlockedError,
  TurnkeyUpstreamError,
} from "@/lib/agentic-wallet/sign";
import {
  broadcastSignedTransaction,
  signEthereumTransaction,
} from "@/lib/agentic-wallet/sign-eth-tx";
import { db } from "@/lib/db";
import {
  agenticWallets,
  feedback,
  workflowExecutions,
  workflowPayments,
  workflows,
} from "@/lib/db/schema";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { getRpcUrlByChainId } from "@/lib/rpc/rpc-config";

export const dynamic = "force-dynamic";

type FeedbackRequestBody = {
  executionId?: unknown;
  value?: unknown;
  valueDecimals?: unknown;
  comment?: unknown;
  agentChainId?: unknown;
  agentId?: unknown;
  // Part of the agentic-wallet client contract; see ValidatedInput.forceBroadcast.
  forceBroadcast?: unknown;
};

type ValidatedInput = {
  executionId: string;
  value: bigint;
  valueDecimals: number;
  comment?: string;
  agentChainId: number;
  agentId: bigint;
  // Accepted to honor the agentic-wallet client contract, but intentionally
  // not branched on: a null-txHash feedback row is always retryable
  // regardless of this flag, so the retry path is never gated on it.
  forceBroadcast: boolean;
};

function badRequest(message: string, code = "BAD_INPUT"): NextResponse {
  return NextResponse.json({ error: message, code }, { status: 400 });
}

// Thrown by buildAndSignTx when the caller wallet cannot cover mainnet gas
// for the giveFeedback() tx. Surfaced as a clean 402 INSUFFICIENT_GAS so the
// caller can fund the wallet and retry the now-stranded feedback row
// (KEEP-515), instead of estimateGas/broadcast failing opaquely.
class InsufficientGasError extends Error {
  readonly balanceWei: bigint;
  readonly requiredWei: bigint | null;
  constructor(balanceWei: bigint, requiredWei: bigint | null) {
    const need =
      requiredWei === null
        ? "any mainnet gas"
        : `the ~${requiredWei} wei needed for mainnet gas`;
    super(`Wallet balance ${balanceWei} wei is below ${need}`);
    this.name = "InsufficientGasError";
    this.balanceWei = balanceWei;
    this.requiredWei = requiredWei;
  }
}

// Hoisted to module scope per useTopLevelRegex (avoids re-parsing the
// pattern on every parse call).
const INT_LITERAL_RE = /^-?\d+$/;

function tryParseBigInt(value: unknown): bigint | null {
  if (typeof value === "string" && INT_LITERAL_RE.test(value)) {
    try {
      return BigInt(value);
    } catch {
      return null;
    }
  }
  if (typeof value === "number" && Number.isInteger(value)) {
    return BigInt(value);
  }
  return null;
}

function validateInput(body: FeedbackRequestBody): ValidatedInput | string {
  if (typeof body.executionId !== "string" || body.executionId.length === 0) {
    return "executionId required";
  }
  const value = tryParseBigInt(body.value);
  if (value === null) {
    return "value must be an integer (string or number)";
  }
  // int128 range. BigInt literals (1n) are ES2020 only; this project
  // targets ES2017 so we go through the constructor.
  const INT128_MAX = (BigInt(1) << BigInt(127)) - BigInt(1);
  const INT128_MIN = -(BigInt(1) << BigInt(127));
  if (value > INT128_MAX || value < INT128_MIN) {
    return "value outside int128 range";
  }
  if (
    typeof body.valueDecimals !== "number" ||
    !Number.isInteger(body.valueDecimals) ||
    body.valueDecimals < 0 ||
    body.valueDecimals > 18
  ) {
    return "valueDecimals must be an integer in [0, 18]";
  }
  if (
    body.comment !== undefined &&
    (typeof body.comment !== "string" || body.comment.length > 2000)
  ) {
    return "comment must be a string <= 2000 chars";
  }
  // Default to Ethereum mainnet + KeeperHub agent id; allow override per
  // user instruction "any agent" (Turnkey policy does not constrain agentId).
  let agentChainId: number;
  if (body.agentChainId === undefined) {
    agentChainId = ETHEREUM_MAINNET_CHAIN_ID;
  } else if (
    typeof body.agentChainId === "number" &&
    Number.isInteger(body.agentChainId)
  ) {
    agentChainId = body.agentChainId;
  } else {
    return "agentChainId must be an integer";
  }
  // Today the Turnkey signTransaction policy only allows chain_id=1 for the
  // ReputationRegistry. Reject any other agentChainId at the application
  // layer before the Turnkey roundtrip wastes time.
  if (agentChainId !== ETHEREUM_MAINNET_CHAIN_ID) {
    return `agentChainId ${agentChainId} not supported (only ${ETHEREUM_MAINNET_CHAIN_ID} today)`;
  }
  const agentIdRaw = body.agentId ?? KEEPERHUB_ERC_8004_AGENT_ID;
  const agentId = tryParseBigInt(agentIdRaw);
  if (agentId === null || agentId < BigInt(0)) {
    return "agentId must be a non-negative integer";
  }
  return {
    executionId: body.executionId,
    value,
    valueDecimals: body.valueDecimals,
    comment: typeof body.comment === "string" ? body.comment : undefined,
    agentChainId,
    agentId,
    forceBroadcast: body.forceBroadcast === true,
  };
}

type WalletResolveResult =
  | { ok: true; subOrgId: string; walletAddress: `0x${string}` }
  | { ok: false; status: number; error: string };

async function resolveWallet(subOrgId: string): Promise<WalletResolveResult> {
  const rows = await db
    .select({
      walletAddress: agenticWallets.walletAddressBase,
    })
    .from(agenticWallets)
    .where(eq(agenticWallets.subOrgId, subOrgId))
    .limit(1);
  const row = rows[0];
  if (!row) {
    return { ok: false, status: 401, error: "Sub-org not found" };
  }
  return {
    ok: true,
    subOrgId,
    walletAddress: row.walletAddress as `0x${string}`,
  };
}

type ExecutionVerifyResult =
  | { ok: true; workflowId: string; workflowSlug: string | null }
  | { ok: false; status: number; error: string; code: string };

async function verifyExecutionAndPayer(args: {
  executionId: string;
  walletAddress: `0x${string}`;
}): Promise<ExecutionVerifyResult> {
  const rows = await db
    .select({
      executionId: workflowExecutions.id,
      workflowId: workflowExecutions.workflowId,
      executionStatus: workflowExecutions.status,
      workflowSlug: workflows.listedSlug,
      payerAddress: workflowPayments.payerAddress,
    })
    .from(workflowExecutions)
    .leftJoin(workflows, eq(workflows.id, workflowExecutions.workflowId))
    .leftJoin(
      workflowPayments,
      eq(workflowPayments.executionId, workflowExecutions.id)
    )
    .where(eq(workflowExecutions.id, args.executionId))
    .limit(1);
  const row = rows[0];
  if (!row) {
    return {
      ok: false,
      status: 404,
      error: "Execution not found",
      code: "EXECUTION_NOT_FOUND",
    };
  }
  // Allow rating successful and errored executions, but not still-running
  // ones (caller might retract). cancelled/error are still rate-able since
  // they represent a real interaction.
  if (row.executionStatus === "running" || row.executionStatus === "pending") {
    return {
      ok: false,
      status: 409,
      error: "Execution still in progress",
      code: "EXECUTION_NOT_FINAL",
    };
  }
  // payerAddress is null for free executions; we permit free rating so
  // the agent score moves on free workflows too. For paid executions the
  // payer must match.
  if (
    row.payerAddress !== null &&
    row.payerAddress !== undefined &&
    row.payerAddress.toLowerCase() !== args.walletAddress.toLowerCase()
  ) {
    return {
      ok: false,
      status: 403,
      error: "Caller wallet did not pay for this execution",
      code: "NOT_PAYER",
    };
  }
  return {
    ok: true,
    workflowId: row.workflowId,
    workflowSlug: row.workflowSlug ?? null,
  };
}

type ExistingFeedbackRow = {
  id: string;
  txHash: string | null;
  status: string;
  createdAt: Date;
};

// Returns the prior feedback row for this (execution, wallet) pair, if any.
// The caller decides what to do with it: a row with a non-empty txHash is a
// real on-chain rating (reject as ALREADY_RATED), but a row with a null
// txHash is a stranded/in-flight attempt that must be reused so the user is
// not permanently stuck (KEEP-515).
async function findExistingFeedback(args: {
  executionId: string;
  payerWallet: string;
}): Promise<ExistingFeedbackRow | null> {
  const existing = await db
    .select({
      id: feedback.id,
      txHash: feedback.txHash,
      status: feedback.status,
      createdAt: feedback.createdAt,
    })
    .from(feedback)
    .where(
      and(
        eq(feedback.executionId, args.executionId),
        eq(feedback.payerWallet, args.payerWallet.toLowerCase())
      )
    )
    .limit(1);
  return existing[0] ?? null;
}

async function buildAndSignTx(args: {
  subOrgId: string;
  walletAddress: `0x${string}`;
  agentChainId: number;
  agentId: bigint;
  value: bigint;
  valueDecimals: number;
  feedbackId: string;
  feedbackHash: Hex;
}): Promise<{ signedTx: Hex; publicBaseUrl: string }> {
  const publicBaseUrl =
    process.env.KEEPERHUB_PUBLIC_BASE_URL ?? "https://app.keeperhub.com";
  const feedbackURI = `${publicBaseUrl}/api/feedback/${args.feedbackId}`;

  const calldata = buildGiveFeedbackCalldata({
    agentId: args.agentId,
    value: args.value,
    valueDecimals: args.valueDecimals,
    feedbackURI,
    feedbackHash: args.feedbackHash,
  });

  const rpcUrl = getRpcUrlByChainId(args.agentChainId);
  const publicClient = createPublicClient({
    chain: mainnet,
    transport: http(rpcUrl),
  });

  // Live network reads -- nonce + balance + gas estimate + fee estimate.
  // Each one hits the upstream RPC; we await sequentially to keep error
  // surfacing crisp (and Promise.all would still be sequential because of
  // viem's single-connection transport in practice).
  const nonce = await publicClient.getTransactionCount({
    address: args.walletAddress,
    blockTag: "pending",
  });
  // Gas preflight. The caller wallet pays mainnet gas natively, so a wallet
  // with no ETH cannot complete this tx. Check the balance up front: a zero
  // balance short-circuits before estimateGas, which on a 0-balance account
  // can fail opaquely or stall on some RPC providers. A non-zero balance is
  // re-checked against the real estimated cost once it is known.
  const balanceWei = await publicClient.getBalance({
    address: args.walletAddress,
  });
  if (balanceWei === BigInt(0)) {
    throw new InsufficientGasError(balanceWei, null);
  }
  const gas = await publicClient.estimateGas({
    account: args.walletAddress,
    to: ERC_8004_REPUTATION_REGISTRY_ADDRESS,
    data: calldata,
    value: BigInt(0),
  });
  // 20% headroom over the estimate -- defends against mid-mempool gas
  // bumps invalidating the broadcast. Cheap insurance on a $3-10 tx.
  const gasWithHeadroom = (gas * BigInt(12)) / BigInt(10);
  const fees = await publicClient.estimateFeesPerGas();
  // Reject before signing if the balance cannot cover the estimated cost.
  const requiredWei = gasWithHeadroom * fees.maxFeePerGas;
  if (balanceWei < requiredWei) {
    throw new InsufficientGasError(balanceWei, requiredWei);
  }

  const unsignedTx = serializeTransaction({
    chainId: args.agentChainId,
    type: "eip1559",
    nonce,
    to: ERC_8004_REPUTATION_REGISTRY_ADDRESS,
    value: BigInt(0),
    data: calldata,
    gas: gasWithHeadroom,
    maxFeePerGas: fees.maxFeePerGas,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
  });

  const { signedTransaction } = await signEthereumTransaction({
    subOrgId: args.subOrgId,
    walletAddress: args.walletAddress,
    // Turnkey expects the unsigned RLP without the 0x prefix.
    unsignedTransactionHex: unsignedTx.startsWith("0x")
      ? unsignedTx.slice(2)
      : unsignedTx,
  });
  return { signedTx: signedTransaction, publicBaseUrl };
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const rawBody = await request.text();
  const verify = await verifyHmacRequest(request, rawBody);
  if (!verify.ok) {
    return NextResponse.json(
      { error: verify.error },
      { status: verify.status }
    );
  }

  let parsed: FeedbackRequestBody;
  try {
    parsed = JSON.parse(rawBody) as FeedbackRequestBody;
  } catch {
    return badRequest("Invalid JSON body");
  }
  const validated = validateInput(parsed);
  if (typeof validated === "string") {
    return badRequest(validated);
  }

  const wallet = await resolveWallet(verify.subOrgId);
  if (!wallet.ok) {
    return NextResponse.json(
      { error: wallet.error },
      { status: wallet.status }
    );
  }

  const exec = await verifyExecutionAndPayer({
    executionId: validated.executionId,
    walletAddress: wallet.walletAddress,
  });
  if (!exec.ok) {
    return NextResponse.json(
      { error: exec.error, code: exec.code },
      { status: exec.status }
    );
  }

  const existingRow = await findExistingFeedback({
    executionId: validated.executionId,
    payerWallet: wallet.walletAddress,
  });
  // A row with a non-empty txHash is a real on-chain rating -- reject. A row
  // with a null/empty txHash is a stranded or in-flight attempt (e.g. a
  // broadcast that failed for lack of gas); reuse it so the caller can
  // retry instead of being permanently locked out (KEEP-515). This retry is
  // unconditional -- see the note on ValidatedInput.forceBroadcast.
  if (existingRow?.txHash && existingRow.txHash.length > 0) {
    return NextResponse.json(
      {
        error: "Wallet has already submitted feedback for this execution",
        code: "ALREADY_RATED",
        feedbackId: existingRow.id,
      },
      { status: 409 }
    );
  }

  // We need a feedback row id before we can build the feedbackURI, compute
  // the hash, and encode the giveFeedback call. On a fresh request we
  // INSERT; on a retry of a stranded row we reuse the existing id and its
  // original createdAt (so the already-derived feedbackURI stays stable)
  // and reset its status to "pending" with the error cleared. Both paths
  // produce the same downstream variables.
  let feedbackId: string;
  let feedbackCreatedAt: Date;
  if (existingRow) {
    // Refresh every input-derived field, not just status/error. The
    // on-chain feedbackHash below is computed from the current `validated`
    // input, and `/api/feedback/[id]` later rebuilds the served JSON from
    // this row -- so a retry with changed value/comment/agentId must
    // overwrite the stale values or keccak256(servedBytes) won't match the
    // committed hash. createdAt is intentionally left untouched (it feeds
    // the hash and the feedbackURI must stay stable).
    await db
      .update(feedback)
      .set({
        status: "pending",
        error: null,
        workflowId: exec.workflowId,
        agentChainId: validated.agentChainId,
        agentId: validated.agentId.toString(),
        value: validated.value.toString(),
        valueDecimals: validated.valueDecimals,
        comment: validated.comment ?? null,
        txChainId: validated.agentChainId,
      })
      .where(eq(feedback.id, existingRow.id));
    feedbackId = existingRow.id;
    feedbackCreatedAt = existingRow.createdAt;
  } else {
    const inserted = await db
      .insert(feedback)
      .values({
        executionId: validated.executionId,
        workflowId: exec.workflowId,
        agentChainId: validated.agentChainId,
        agentId: validated.agentId.toString(),
        payerWallet: wallet.walletAddress.toLowerCase(),
        value: validated.value.toString(),
        valueDecimals: validated.valueDecimals,
        comment: validated.comment ?? null,
        txChainId: validated.agentChainId,
        status: "pending",
      })
      .returning({ id: feedback.id, createdAt: feedback.createdAt });
    const newRow = inserted[0];
    if (!newRow) {
      return NextResponse.json(
        { error: "Failed to insert feedback row" },
        { status: 500 }
      );
    }
    feedbackId = newRow.id;
    feedbackCreatedAt = newRow.createdAt;
  }

  // Compute the canonical feedbackURI JSON + its keccak256. The hash MUST
  // match what `/api/feedback/[id]` will serve later for the on-chain
  // commitment to verify.
  const content = buildFeedbackUriContent({
    agentChainId: validated.agentChainId,
    agentId: validated.agentId,
    clientAddress: wallet.walletAddress,
    createdAt: feedbackCreatedAt,
    value: validated.value,
    valueDecimals: validated.valueDecimals,
    comment: validated.comment,
    workflowSlug: exec.workflowSlug ?? undefined,
    executionId: validated.executionId,
  });
  const feedbackHash = hashFeedbackContent(content);

  let signedTx: Hex;
  let publicBaseUrl: string;
  try {
    const result = await buildAndSignTx({
      subOrgId: wallet.subOrgId,
      walletAddress: wallet.walletAddress,
      agentChainId: validated.agentChainId,
      agentId: validated.agentId,
      value: validated.value,
      valueDecimals: validated.valueDecimals,
      feedbackId,
      feedbackHash,
    });
    signedTx = result.signedTx;
    publicBaseUrl = result.publicBaseUrl;
  } catch (err) {
    await db
      .update(feedback)
      .set({
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
      })
      .where(eq(feedback.id, feedbackId));
    if (err instanceof InsufficientGasError) {
      return NextResponse.json(
        {
          error: err.message,
          code: "INSUFFICIENT_GAS",
          feedbackId,
          balanceWei: err.balanceWei.toString(),
          ...(err.requiredWei === null
            ? {}
            : { requiredWei: err.requiredWei.toString() }),
        },
        { status: 402 }
      );
    }
    if (err instanceof PolicyBlockedError) {
      return NextResponse.json(
        { error: err.message, code: "POLICY_BLOCKED", feedbackId },
        { status: 403 }
      );
    }
    if (err instanceof TurnkeyUpstreamError) {
      logSystemError(
        ErrorCategory.WORKFLOW_ENGINE,
        "[feedback] Turnkey signing failed",
        err,
        { endpoint: "/api/agentic-wallet/feedback", feedbackId }
      );
      return NextResponse.json(
        {
          error: "Upstream signing failed",
          code: "TURNKEY_UPSTREAM",
          feedbackId,
        },
        { status: 502 }
      );
    }
    logSystemError(
      ErrorCategory.WORKFLOW_ENGINE,
      "[feedback] Build/sign failed",
      err,
      { endpoint: "/api/agentic-wallet/feedback", feedbackId }
    );
    return NextResponse.json(
      { error: "Failed to prepare or sign tx", feedbackId },
      { status: 500 }
    );
  }

  let txHash: Hex;
  try {
    const broadcast = await broadcastSignedTransaction({
      signedTransaction: signedTx,
      chainId: validated.agentChainId,
    });
    txHash = broadcast.txHash;
  } catch (err) {
    await db
      .update(feedback)
      .set({
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
      })
      .where(eq(feedback.id, feedbackId));
    logSystemError(
      ErrorCategory.WORKFLOW_ENGINE,
      "[feedback] RPC broadcast failed",
      err,
      { endpoint: "/api/agentic-wallet/feedback", feedbackId }
    );
    return NextResponse.json(
      {
        error: "Broadcast failed",
        code: "RPC_UPSTREAM",
        feedbackId,
      },
      { status: 502 }
    );
  }

  await db
    .update(feedback)
    .set({
      status: "broadcast",
      txHash,
      feedbackHash,
      broadcastAt: new Date(),
    })
    .where(eq(feedback.id, feedbackId));

  return NextResponse.json({
    feedbackId,
    txHash,
    publicUrl: `${publicBaseUrl}/api/feedback/${feedbackId}`,
  });
}
