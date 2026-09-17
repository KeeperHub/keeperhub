import "server-only";

import type { DisbursementLeg } from "@/lib/db/schema";
import { ExecutionErrorType } from "@/lib/errors/execution-error-type";
import { checkStablecoinTransferAmountBatch } from "@/lib/execute/stablecoin-cap";
import { withStepValueCap } from "@/lib/execute/value-ledger";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { getChainIdFromNetwork } from "@/lib/rpc/network-utils";
import { isSolanaChain } from "@/lib/rpc/solana-chains";
import { resolveSignerForNode, SIGNER_MODE } from "@/lib/safe/signer-resolver";
import { getErrorMessage } from "@/lib/utils";
import type { BroadcastEvent } from "@/lib/web3/broadcast-hook";
import {
  applyReceiptVerdict,
  claimNewLeg,
  type LegKey,
  readReceiptRecords,
  readRunLegs,
  reclaimLeg,
  recordBroadcastEvent,
  recordOutcome,
} from "@/lib/web3/disbursement-ledger";
import {
  assetKey,
  canonicalAmount,
  type DisburseAssetKind,
  type LegSpec,
  parseLegs,
  planLeg,
  receiptVerdict,
  recipientKey,
  validateRunKey,
} from "@/lib/web3/disbursement-plan";
import { resolveOrganizationContext } from "@/lib/web3/resolve-org-context";
import { validateChainAddress } from "@/lib/web3/validate-chain-address";
import type { StepContext } from "@/lib/workflow/executor/step-handler";
import { transferFundsCore } from "./transfer-funds-core";
import { transferSplTokenCore } from "./transfer-spl-token-core";
import { transferTokenCore } from "./transfer-token-core";

export type DisburseCoreInput = {
  network: string;
  assetType: string;
  /** ERC-20 token address, for assetType "erc20". */
  tokenAddress?: string;
  /** SPL mint address, for assetType "spl". */
  mint?: string;
  /** Names the payout run across executions. Required. */
  runKey: string;
  /** JSON array (or array) of {recipient, amount}. Order is the leg index. */
  legs: string | unknown[];
  _context?: StepContext;
};

export type DisburseLegStatus =
  /** Sent and confirmed by this run. */
  | "paid"
  /** Settled by an earlier run, or resolved as paid; not sent again. */
  | "already_paid"
  /** Certainly not paid; the next run with this key sends it again. */
  | "failed"
  /** May have paid. Stops the run; resolve it before re-running. */
  | "unknown"
  /** Held by another run that is still going. */
  | "in_progress"
  /** Recorded with a different network, asset, recipient or amount. */
  | "conflict"
  /** Not reached, because the run stopped first. */
  | "not_attempted";

export type DisburseLegResult = {
  index: number;
  recipient: string;
  amount: string;
  status: DisburseLegStatus;
  transactionHash?: string;
  sendTransactionStatusId?: string;
  error?: string;
};

type Counts = Record<DisburseLegStatus, number>;

export type DisburseResult =
  | {
      success: true;
      runKey: string;
      chainId: number;
      results: DisburseLegResult[];
      counts: Counts;
      /** Every transaction this execution broadcast, one per leg. */
      legTransactions: Array<{ hash: string; chainId: number; legIndex: number }>;
    }
  | {
      success: false;
      error: string;
      errorClass?: ExecutionErrorType;
      runKey?: string;
      chainId?: number;
      results?: DisburseLegResult[];
      counts?: Counts;
      legTransactions?: Array<{
        hash: string;
        chainId: number;
        legIndex: number;
      }>;
    };

type Setup = {
  organizationId: string;
  network: string;
  /** As given, for the transfer core; the ledger stores it lowercased. */
  tokenAddress?: string;
  chainId: number;
  isSolana: boolean;
  kind: DisburseAssetKind;
  runKey: string;
  specs: LegSpec[];
  /** The original strings, reported back as given. */
  inputs: Array<{ recipient: string; amount: string }>;
};

const ASSET_KINDS: readonly DisburseAssetKind[] = ["native", "erc20", "spl"];

function emptyCounts(): Counts {
  return {
    paid: 0,
    already_paid: 0,
    failed: 0,
    unknown: 0,
    in_progress: 0,
    conflict: 0,
    not_attempted: 0,
  };
}

function count(results: DisburseLegResult[]): Counts {
  const counts = emptyCounts();
  for (const r of results) {
    counts[r.status] += 1;
  }
  return counts;
}

/**
 * Everything checked before the ledger is touched. A failure here sends
 * nothing and records nothing.
 */
async function prepare(
  input: DisburseCoreInput
): Promise<{ ok: true; setup: Setup } | { ok: false; error: string }> {
  let chainId: number;
  try {
    chainId = getChainIdFromNetwork(input.network);
  } catch (error) {
    return { ok: false, error: getErrorMessage(error) };
  }
  const isSolana = isSolanaChain(chainId);

  const kind = input.assetType as DisburseAssetKind;
  if (!ASSET_KINDS.includes(kind)) {
    return {
      ok: false,
      error: `Asset type must be one of ${ASSET_KINDS.join(", ")}`,
    };
  }
  if (kind === "erc20" && isSolana) {
    return {
      ok: false,
      error: "ERC-20 legs need an EVM network; use SPL on Solana",
    };
  }
  if (kind === "spl" && !isSolana) {
    return { ok: false, error: "SPL legs need a Solana network" };
  }

  const asset = assetKey(kind, kind === "erc20" ? input.tokenAddress : input.mint);
  if (asset === null) {
    return {
      ok: false,
      error:
        kind === "erc20"
          ? "A valid ERC-20 token address is required"
          : "An SPL mint address is required",
    };
  }
  if (kind === "spl" && !validateChainAddress(asset.slice(4), chainId)) {
    return { ok: false, error: "The SPL mint is not a valid Solana address" };
  }

  const runKey = validateRunKey(input.runKey);
  if (runKey === null) {
    return {
      ok: false,
      error:
        "A run key is required: it names this payout run so a re-run can skip the legs that already paid",
    };
  }

  const parsed = parseLegs(input.legs);
  if (!parsed.ok) {
    return { ok: false, error: parsed.error };
  }
  const specs: LegSpec[] = [];
  for (const [index, leg] of parsed.legs.entries()) {
    if (!validateChainAddress(leg.recipient, chainId)) {
      return {
        ok: false,
        error: `Leg ${index} recipient is not a valid ${isSolana ? "Solana" : "EVM"} address`,
      };
    }
    specs.push({
      index,
      chainId,
      asset,
      recipient: recipientKey(leg.recipient, isSolana),
      amount: canonicalAmount(leg.amount) as string,
    });
  }

  const context = input._context;
  if (!(context?.executionId || context?.organizationId)) {
    return { ok: false, error: "Execution context is required" };
  }
  const orgCtx = await resolveOrganizationContext(
    context,
    "[Disburse]",
    "disburse"
  );
  if (!orgCtx.success) {
    return { ok: false, error: orgCtx.error };
  }

  // Bounds what this ENTIRE execution moves, not just one leg.
  // transferTokenCore already runs checkStablecoinTransferAmount per leg
  // right before it sends, which bounds any single recipient; nothing
  // bounded the sum across legs, and at MAX_DISBURSE_LEGS legs of the
  // per-transfer ceiling each, the sum clears the platform's own
  // per-transaction batch ceiling by several multiples. Scoped to erc20:
  // native value is already a cumulative daily ledger charged per leg as it
  // sends, and SPL has no aggregate check to add to here.
  if (kind === "erc20") {
    const capDecision = await checkStablecoinTransferAmountBatch({
      organizationId: orgCtx.organizationId,
      chainId,
      tokenAddress: input.tokenAddress?.trim() ?? "",
      amounts: specs.map((s) => s.amount),
      context: "web3/disburse",
    });
    if (capDecision.kind === "denied") {
      return { ok: false, error: capDecision.error };
    }
  }

  // Refused up front, before anything is claimed. The Safe and Role signer
  // paths broadcast through helpers that never run the pre-broadcast hook,
  // and a leg sent without it could be reported failed after it went out.
  if (!isSolana) {
    let mode: Awaited<ReturnType<typeof resolveSignerForNode>>;
    try {
      mode = await resolveSignerForNode({
        organizationId: orgCtx.organizationId,
        chainId,
        web3Connection: undefined,
      });
    } catch (error) {
      return {
        ok: false,
        error: `Failed to resolve the signer: ${getErrorMessage(error)}`,
      };
    }
    if (mode.kind !== SIGNER_MODE.EOA) {
      return {
        ok: false,
        error:
          "Disburse sends from the organization wallet only. This network is set to a Safe or Role signer, which Disburse does not support yet.",
      };
    }
  }

  return {
    ok: true,
    setup: {
      organizationId: orgCtx.organizationId,
      network: input.network,
      tokenAddress: input.tokenAddress?.trim(),
      chainId,
      isSolana,
      kind,
      runKey,
      specs,
      inputs: parsed.legs,
    },
  };
}

type Decision =
  | { kind: "send"; reclaimFrom?: DisbursementLeg }
  | { kind: "done"; result: DisburseLegResult }
  | { kind: "stop"; result: DisburseLegResult };

/**
 * Decide every leg before sending any. A leg that conflicts, is held by a live
 * run, or may have paid stops the whole run: an unresolved EVM send can still
 * hold a nonce, and a list that changed under the same key is not the payout
 * the key names.
 */
async function decide(setup: Setup): Promise<Decision[]> {
  const rows = await readRunLegs(setup.organizationId, setup.runKey);
  const byIndex = new Map(rows.map((row) => [row.legIndex, row]));
  const evidenceIds = rows
    .filter((r) => (r.status === "sending" || r.status === "unknown") && r.executionId)
    .map((r) => r.executionId as string);
  const receipts = await readReceiptRecords(evidenceIds);
  const now = new Date();

  const decisions: Decision[] = [];
  for (const spec of setup.specs) {
    const row = byIndex.get(spec.index);
    const base = {
      index: spec.index,
      recipient: setup.inputs[spec.index].recipient,
      amount: setup.inputs[spec.index].amount,
    };
    const plan = planLeg(spec, row, now);
    switch (plan.action) {
      case "send":
        decisions.push({ kind: "send", reclaimFrom: plan.reclaim ? row : undefined });
        break;
      case "already_paid":
        decisions.push({
          kind: "done",
          result: {
            ...base,
            status: "already_paid",
            ...(plan.transactionHash ? { transactionHash: plan.transactionHash } : {}),
          },
        });
        break;
      case "conflict":
        decisions.push({
          kind: "stop",
          result: {
            ...base,
            status: "conflict",
            error: `This run key already recorded leg ${spec.index} with a different ${plan.field}. Use a new run key for a different payout.`,
          },
        });
        break;
      case "in_progress":
        decisions.push({
          kind: "stop",
          result: {
            ...base,
            status: "in_progress",
            error: "Another run with this key is sending this leg",
          },
        });
        break;
      case "check_evidence": {
        const seen = row as DisbursementLeg;
        const verdict =
          seen.transactionHash && seen.executionId
            ? receiptVerdict(
                receipts.get(seen.executionId),
                seen.transactionHash
              )
            : "unknown";
        const key: LegKey = {
          organizationId: setup.organizationId,
          runKey: setup.runKey,
          legIndex: spec.index,
        };
        if (verdict === "settled" && (await applyReceiptVerdict(key, seen, "settled"))) {
          decisions.push({
            kind: "done",
            result: {
              ...base,
              status: "already_paid",
              transactionHash: seen.transactionHash as string,
            },
          });
          break;
        }
        if (verdict === "failed" && (await applyReceiptVerdict(key, seen, "failed"))) {
          const refreshed = { ...seen, status: "failed" as const };
          decisions.push({ kind: "send", reclaimFrom: refreshed });
          break;
        }
        decisions.push({
          kind: "stop",
          result: {
            ...base,
            status: "unknown",
            ...(seen.transactionHash ? { transactionHash: seen.transactionHash } : {}),
            ...(seen.sendTransactionStatusId
              ? { sendTransactionStatusId: seen.sendTransactionStatusId }
              : {}),
            error:
              "This leg may already have paid. Check it on chain and resolve it before running again.",
          },
        });
        break;
      }
      default:
        break;
    }
  }
  return decisions;
}

type SendTracker = {
  /** True once a pre-broadcast event recorded the leg as possibly sent. */
  inFlight: boolean;
  transactionHash?: string;
  sendTransactionStatusId?: string;
};

type TransferOutcome = {
  success: boolean;
  transactionHash?: string;
  error?: string;
  sendTransactionStatusId?: string;
};

function sendLeg(
  setup: Setup,
  spec: LegSpec,
  recipient: string,
  amount: string,
  context: StepContext | undefined,
  hook: (event: BroadcastEvent) => Promise<void>
): Promise<TransferOutcome> {
  const coreContext = {
    executionId: context?.executionId,
    organizationId: setup.organizationId,
    workflowId: context?.workflowId,
  };
  if (setup.kind === "erc20") {
    return transferTokenCore({
      network: setup.network,
      tokenConfig: setup.tokenAddress ?? spec.asset.slice("erc20:".length),
      recipientAddress: recipient,
      amount,
      _context: coreContext,
      _broadcastHook: hook,
    }) as Promise<TransferOutcome>;
  }
  if (setup.kind === "spl") {
    return withStepValueCap(
      {
        organizationId: setup.organizationId,
        stepFunction: "transferSplTokenStep",
        config: { network: setup.network },
        executionId: context?.executionId,
        // Nothing was reserved up front for this step on any path
        // (lib/execute/reserved-value.ts), so every leg is charged here.
        valueCapReserved: false,
      },
      () =>
        transferSplTokenCore({
          network: setup.network,
          mint: spec.asset.slice("spl:".length),
          recipientAddress: recipient,
          amount,
          _context: coreContext,
          _broadcastHook: hook,
        })
    ) as Promise<TransferOutcome>;
  }
  return withStepValueCap(
    {
      organizationId: setup.organizationId,
      stepFunction: "transferFundsStep",
      config: { network: setup.network, amount },
      executionId: context?.executionId,
      // Nothing was reserved up front for this step on any path
        // (lib/execute/reserved-value.ts), so every leg is charged here.
        valueCapReserved: false,
    },
    () =>
      transferFundsCore({
        network: setup.network,
        amount,
        recipientAddress: recipient,
        _context: coreContext,
        _broadcastHook: hook,
      })
  ) as Promise<TransferOutcome>;
}

/**
 * Pay a list of legs, one at a time, recording each in the run ledger so a
 * re-run under the same key skips what already paid.
 */
export async function disburseCore(
  input: DisburseCoreInput
): Promise<DisburseResult> {
  const prepared = await prepare(input);
  if (!prepared.ok) {
    return { success: false, error: prepared.error };
  }
  const { setup } = prepared;
  const context = input._context;

  let decisions: Decision[];
  try {
    decisions = await decide(setup);
  } catch (error) {
    logSystemError(
      ErrorCategory.DATABASE,
      "[Disburse] Failed to read the run ledger",
      error,
      { plugin_name: "web3", action_name: "disburse" }
    );
    return {
      success: false,
      error: `Could not read the run ledger, so nothing was sent: ${getErrorMessage(error)}`,
      runKey: setup.runKey,
      chainId: setup.chainId,
    };
  }

  const results: DisburseLegResult[] = [];
  const legTransactions: Array<{ hash: string; chainId: number; legIndex: number }> =
    [];

  const blocked = decisions.some((d) => d.kind === "stop");
  let stopped = blocked;

  for (const [index, decision] of decisions.entries()) {
    const spec = setup.specs[index];
    const recipient = setup.inputs[index].recipient;
    const amount = setup.inputs[index].amount;
    const base = { index, recipient, amount };

    if (decision.kind !== "send") {
      results.push(decision.result);
      continue;
    }
    if (stopped) {
      results.push({ ...base, status: "not_attempted" });
      continue;
    }

    const key: LegKey = {
      organizationId: setup.organizationId,
      runKey: setup.runKey,
      legIndex: index,
    };
    const claimer = { executionId: context?.executionId, nodeId: context?.nodeId };
    let token: string | null;
    try {
      token = decision.reclaimFrom
        ? await reclaimLeg(key, decision.reclaimFrom, claimer)
        : await claimNewLeg(key, spec, claimer);
    } catch (error) {
      results.push({
        ...base,
        status: "not_attempted",
        error: `Could not record the leg before sending, so it was not sent: ${getErrorMessage(error)}`,
      });
      stopped = true;
      continue;
    }
    if (token === null) {
      results.push({
        ...base,
        status: "in_progress",
        error: "Another run with this key took this leg first",
      });
      stopped = true;
      continue;
    }

    const held = token;
    const tracker: SendTracker = { inFlight: false };
    const hook = async (event: BroadcastEvent): Promise<void> => {
      await recordBroadcastEvent(key, held, event);
      switch (event.kind) {
        case "evm-signed":
          tracker.inFlight = true;
          tracker.transactionHash = event.transactionHash;
          break;
        case "solana-signed":
          tracker.inFlight = true;
          tracker.transactionHash = event.signature;
          break;
        case "sponsored-submitting":
          tracker.inFlight = true;
          break;
        case "sponsored-accepted":
          tracker.sendTransactionStatusId = event.sendTransactionStatusId;
          break;
        case "sponsored-not-broadcast":
          tracker.inFlight = false;
          break;
        default:
          break;
      }
    };

    let outcome: TransferOutcome;
    try {
      outcome = await sendLeg(setup, spec, recipient, amount, context, hook);
    } catch (error) {
      outcome = { success: false, error: getErrorMessage(error) };
    }

    if (outcome.success && outcome.transactionHash) {
      await recordOutcome(key, held, {
        status: "settled",
        transactionHash: outcome.transactionHash,
      }).catch(() => undefined);
      legTransactions.push({
        hash: outcome.transactionHash,
        chainId: setup.chainId,
        legIndex: index,
      });
      results.push({ ...base, status: "paid", transactionHash: outcome.transactionHash });
      continue;
    }

    const error = outcome.error ?? "Transfer failed";
    if (!tracker.inFlight) {
      // The pre-broadcast hook never recorded this leg as sent, so nothing
      // left: the only case a failed step result is read as not paid.
      await recordOutcome(key, held, { status: "failed", error }).catch(
        () => undefined
      );
      results.push({ ...base, status: "failed", error });
      continue;
    }

    const hash = outcome.transactionHash ?? tracker.transactionHash;
    const statusId =
      outcome.sendTransactionStatusId ?? tracker.sendTransactionStatusId;
    await recordOutcome(key, held, {
      status: "unknown",
      error,
      transactionHash: hash,
      sendTransactionStatusId: statusId,
    }).catch(() => undefined);
    if (hash) {
      legTransactions.push({ hash, chainId: setup.chainId, legIndex: index });
    }
    results.push({
      ...base,
      status: "unknown",
      error: `This leg may have paid: ${error}`,
      ...(hash ? { transactionHash: hash } : {}),
      ...(statusId ? { sendTransactionStatusId: statusId } : {}),
    });
    // An unresolved send can still land, and on EVM it can still hold the
    // nonce the next leg would use. Nothing more is sent this run.
    stopped = true;
  }

  const counts = count(results);
  const complete =
    counts.paid + counts.already_paid === results.length;
  if (complete) {
    return {
      success: true,
      runKey: setup.runKey,
      chainId: setup.chainId,
      results,
      counts,
      legTransactions,
    };
  }

  const labels: Array<[number, string]> = [
    [counts.conflict, "conflicting"],
    [counts.in_progress, "held by another run"],
    [counts.unknown, "may have paid"],
    [counts.failed, "failed"],
    [counts.not_attempted, "not attempted"],
  ];
  const problems = labels
    .filter(([n]) => n > 0)
    .map(([n, label]) => `${n} ${label}`);
  return {
    success: false,
    error: `Disbursement incomplete: ${problems.join(", ")} (${counts.paid} paid this run, ${counts.already_paid} already paid)`,
    // A leg that may have paid must never be softened into a success.
    ...(counts.unknown > 0 || counts.in_progress > 0
      ? { errorClass: ExecutionErrorType.SYSTEM }
      : {}),
    runKey: setup.runKey,
    chainId: setup.chainId,
    results,
    counts,
    legTransactions,
  };
}
