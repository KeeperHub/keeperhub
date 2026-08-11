// Opt-in deep-tier validator. Performs network calls (resolveAbi) under
// strict latency caps. WARNINGS ONLY for any ABI mismatch — PITFALLS
// pitfalls #1 and #3.
//
// Hard caps:
//   - per-call timeout 2000ms (Promise.race)
//   - aggregate timeout 3000ms (deadline check in worker loop)
//   - concurrency cap 5 in-flight resolveAbi calls (inlined worker-pool)
//
// The fast-tier validateWorkflow must NEVER import this module — that
// would break the <300ms p95 fast-tier purity gate.

import "server-only";

import { resolveAbi } from "@/lib/abi/cache";
import {
  type ValidationIssue,
  type ValidationResult,
  type ValidatorWorkflow,
  validateWorkflow,
} from "@/lib/mcp/validate-workflow";
import { VALIDATION_WARNING_CODES } from "@/lib/mcp/validate-workflow-codes";
import { isTemplateReference } from "@/lib/mcp/validate-workflow-web3";

export type ValidateWorkflowDeepOptions = {
  /** Chain IDs to consider valid (passed through to the fast tier when 48-02 lands). */
  chainIds?: Set<number>;
  /** Per-call resolveAbi timeout (ms). Default 2000. */
  perCallTimeoutMs?: number;
  /** Aggregate deep-check deadline (ms). Default 3000. */
  aggregateDeadlineMs?: number;
  /** Concurrency cap for resolveAbi calls. Default 5. */
  concurrency?: number;
  /** Test seam: override resolveAbi for unit tests. Defaults to the real resolveAbi. */
  resolveAbiOverride?: typeof resolveAbi;
};

type ContractRef = {
  nodeIdx: number;
  contractAddress: string;
  network: string;
  declaredAbi: string;
  // True for nodes whose actionType belongs to the web3 plugin family —
  // these are the canonical `abi-with-auto-fetch` consumers per
  // plugins/web3/index.ts. Mismatches on these are warnings only.
  // Non-web3 nodes are also treated warnings-only (generous-warning,
  // conservative-error stance per PITFALLS pitfall #1).
  isAbiAutoFetch: boolean;
};

type WorkflowNodeShape = {
  data?: {
    config?: {
      actionType?: unknown;
      contractAddress?: unknown;
      network?: unknown;
      abi?: unknown;
    } & Record<string, unknown>;
  };
};

function isWriteActionType(actionType: unknown): boolean {
  if (typeof actionType !== "string") {
    return false;
  }
  return (
    actionType.includes("write-contract") ||
    actionType.includes("protocol-write")
  );
}

function isAbiCarryingReadType(actionType: unknown): boolean {
  // web3 read-contract / batch-read / query-events also carry an `abi`
  // config field and benefit from the same warning surface.
  if (typeof actionType !== "string") {
    return false;
  }
  return (
    actionType.includes("read-contract") ||
    actionType.includes("query-events") ||
    actionType.includes("protocol-read")
  );
}

/**
 * Walk every node; collect refs for nodes that have all three
 * (contractAddress, network, abi) and whose actionType matches one of
 * the ABI-carrying action families.
 */
export function collectContractRefs(nodes: unknown): ContractRef[] {
  const refs: ContractRef[] = [];
  if (!Array.isArray(nodes)) {
    return refs;
  }
  for (const [idx, node] of nodes.entries()) {
    const config = (node as WorkflowNodeShape)?.data?.config;
    if (config === undefined || config === null) {
      continue;
    }
    const { actionType } = config;
    const isWrite = isWriteActionType(actionType);
    const isRead = isAbiCarryingReadType(actionType);
    if (!(isWrite || isRead)) {
      continue;
    }
    const { contractAddress, network, abi: declaredAbi } = config;
    if (
      typeof contractAddress !== "string" ||
      typeof network !== "string" ||
      typeof declaredAbi !== "string" ||
      contractAddress.length === 0 ||
      network.length === 0 ||
      declaredAbi.length === 0
    ) {
      continue;
    }
    // A template-valued contractAddress (e.g. {{@prep:Prep.addr}}) resolves
    // to a real address only at execution time; feeding the literal template
    // to resolveAbi would always mismatch and emit a spurious warning.
    if (isTemplateReference(contractAddress)) {
      continue;
    }
    const isWeb3 =
      typeof actionType === "string" && actionType.startsWith("web3/");
    refs.push({
      nodeIdx: idx,
      contractAddress,
      network,
      declaredAbi,
      isAbiAutoFetch: isWeb3,
    });
  }
  return refs;
}

/**
 * Inline concurrency cap. No new dependency (avoids pulling in p-limit).
 * Worker-pool pattern: start `concurrency` workers, each pulls the next
 * task from a shared cursor until exhausted or the aggregate deadline fires.
 * Errors inside each worker are swallowed — degraded explorer must not
 * break validation.
 */
async function runWithLimit<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R | null>,
  deadline: number
): Promise<R[]> {
  const results: R[] = [];
  let cursor = 0;

  const makeWorker = async (): Promise<void> => {
    while (cursor < items.length && Date.now() < deadline) {
      const myIdx = cursor;
      cursor += 1;
      const item = items[myIdx];
      if (item === undefined) {
        break;
      }
      try {
        const out = await worker(item);
        if (out !== null) {
          results.push(out);
        }
      } catch {
        // Silent skip — degraded explorer must not break validation
      }
    }
  };

  const workerCount = Math.min(concurrency, items.length);
  const workers = Array.from({ length: workerCount }, makeWorker);

  // Race the worker pool against the aggregate deadline. Whichever settles
  // first wins — any still-running workers are orphaned (their results are
  // simply never pushed because they resolve after we return).
  await Promise.race([
    Promise.all(workers),
    new Promise<void>((resolve) => {
      const remaining = Math.max(0, deadline - Date.now());
      setTimeout(resolve, remaining);
    }),
  ]);

  return results;
}

async function resolveWithTimeout(
  ref: ContractRef,
  perCallTimeoutMs: number,
  resolver: typeof resolveAbi
): Promise<string | null> {
  type RaceResult = { ok: true; abi: string } | { ok: false };

  const result = await Promise.race<RaceResult>([
    resolver({
      contractAddress: ref.contractAddress,
      network: ref.network,
    }).then((r): RaceResult => ({ ok: true, abi: r.abi })),
    new Promise<RaceResult>((resolve) => {
      setTimeout(() => resolve({ ok: false }), perCallTimeoutMs);
    }),
  ]);

  return result.ok ? result.abi : null;
}

/**
 * Best-effort signature-set comparison. Parses both ABI JSON strings and
 * compares the SET of function selectors (name + input types). Order is
 * irrelevant; extra functions in either side is a mismatch.
 *
 * If either ABI fails to parse, returns false so the caller emits a
 * warning. The warning is the safe default — never an error per Pitfall 1.
 */
function compareAbiSignatures(declared: string, resolved: string): boolean {
  const declaredSig = extractSignatureSet(declared);
  const resolvedSig = extractSignatureSet(resolved);
  if (declaredSig === null || resolvedSig === null) {
    return false;
  }
  if (declaredSig.size !== resolvedSig.size) {
    return false;
  }
  for (const s of declaredSig) {
    if (!resolvedSig.has(s)) {
      return false;
    }
  }
  return true;
}

function extractSignatureSet(abiJson: string): Set<string> | null {
  try {
    const parsed: unknown = JSON.parse(abiJson);
    if (!Array.isArray(parsed)) {
      return null;
    }
    const sigs = new Set<string>();
    for (const entry of parsed) {
      if (
        entry !== null &&
        typeof entry === "object" &&
        (entry as { type?: unknown }).type === "function" &&
        typeof (entry as { name?: unknown }).name === "string"
      ) {
        const e = entry as { name: string; inputs?: unknown[] };
        const inputs = Array.isArray(e.inputs)
          ? e.inputs
              .map((i) =>
                i !== null &&
                typeof i === "object" &&
                typeof (i as { type?: unknown }).type === "string"
                  ? (i as { type: string }).type
                  : ""
              )
              .join(",")
          : "";
        sigs.add(`${e.name}(${inputs})`);
      }
    }
    return sigs;
  } catch {
    return null;
  }
}

/**
 * Composed entry point. Runs validateWorkflow (fast tier) first, then
 * appends low-confidence-abi-match warnings for any mismatching contract
 * ref. WARNINGS ONLY — never errors. Three hard caps enforced:
 *   1. Per-call timeout: perCallTimeoutMs (default 2000ms)
 *   2. Aggregate deadline: aggregateDeadlineMs (default 3000ms)
 *   3. Concurrency cap: concurrency (default 5)
 */
export async function validateWorkflowDeep(
  workflow: ValidatorWorkflow,
  opts: ValidateWorkflowDeepOptions = {}
): Promise<ValidationResult> {
  const fast = validateWorkflow(workflow);
  const refs = collectContractRefs(workflow.nodes);
  if (refs.length === 0) {
    return fast;
  }

  const perCallTimeoutMs = opts.perCallTimeoutMs ?? 2000;
  const aggregateDeadlineMs = opts.aggregateDeadlineMs ?? 3000;
  const concurrency = opts.concurrency ?? 5;
  const resolver = opts.resolveAbiOverride ?? resolveAbi;
  const deadline = Date.now() + aggregateDeadlineMs;

  const deepWarnings: ValidationIssue[] = [];

  await runWithLimit(
    refs,
    concurrency,
    async (ref): Promise<null> => {
      const resolvedAbi = await resolveWithTimeout(
        ref,
        perCallTimeoutMs,
        resolver
      );
      if (resolvedAbi === null) {
        // Silent skip — explorer down, contract unverified, or timeout.
        return null;
      }
      if (!compareAbiSignatures(ref.declaredAbi, resolvedAbi)) {
        deepWarnings.push({
          code: VALIDATION_WARNING_CODES.LOW_CONFIDENCE_ABI_MATCH,
          message: `nodes[${ref.nodeIdx}].config.abi does not match the resolved ABI for ${ref.contractAddress} on chain ${ref.network}. Proxy contracts are expected to mismatch (warning only).`,
          parameterPath: `nodes[${ref.nodeIdx}].config.abi`,
        });
      }
      return null;
    },
    deadline
  );

  return {
    ...fast,
    warnings: [...fast.warnings, ...deepWarnings],
  };
}
