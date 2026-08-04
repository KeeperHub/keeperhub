import "server-only";

import {
  parseNativeValueLamports,
  parseNativeValueWei,
} from "@/lib/execute/native-value";
import { getChainIdFromNetwork } from "@/lib/rpc/network-utils";
import { isSolanaChain } from "@/lib/rpc/provider-factory";
import { SOLANA_SPL_MAX_FEE_LAMPORTS } from "@/lib/web3/solana-fees";

export {
  parseNativeValueLamports,
  parseNativeValueWei,
  type ReservedValue,
} from "@/lib/execute/native-value";

/**
 * Solana write steps that can move native SOL by arbitrary means.
 *
 * Both build transactions from caller-supplied instruction data, so the value
 * they move is not derivable from any config field: a raw instruction can
 * invoke any program, and an Anchor call can move lamports through a CPI that
 * never appears in the encoded arguments. Static inspection can only recognise
 * the shapes it special-cases and would reserve "0" for everything else, which
 * is the bypass itself.
 *
 * These steps therefore require an explicit `maxSol` ceiling, declared by the
 * caller and enforced against the simulated balance delta before submit. The
 * value reserved here is that declared ceiling, not the eventual actual spend;
 * the adapter reconciles the ledger down to the true delta after confirmation.
 */
const SOLANA_DECLARED_VALUE_STEPS: ReadonlySet<string> = new Set([
  "sendRawSolanaInstructionStep",
  "callSolanaProgramStep",
]);

/**
 * Native value (wei) reserved for a generic node execution.
 *
 * A native transfer forwards `amount`; every contract-write-style action
 * forwards native value via `ethValue`. Charging `ethValue` on the field name
 * (not the step name) means a future value-forwarding action is charged
 * automatically rather than silently reserving 0 (a cap bypass). Token
 * transfers/approvals and off-chain steps have neither field and correctly
 * reserve "0". `value` is deliberately NOT read -- it names non-broadcasting
 * inputs on other steps (e.g. risk analysis), so charging it would be wrong.
 *
 * The field-name heuristic holds for EVM only because every value-forwarding
 * EVM action happens to use `ethValue`. The Solana write steps carry no such
 * field, so they are matched by step name and fail closed when no ceiling is
 * declared rather than falling through to a "0" reservation.
 *
 * `maxSol` is parsed at SOL's native 9 decimals and charged against the org's
 * separate lamports-denominated Solana cap, never against the wei cap. The two
 * are different assets and the caps are independent, so no scaling fudge is
 * needed to make them share a number.
 */
export type NodeReservedValue =
  | { ok: true; kind: "evm"; valueWei: string }
  | { ok: true; kind: "solana"; valueLamports: string }
  | { ok: false; error: string };

export function parseNodeNativeValueWei(
  stepFunction: string,
  config: Record<string, unknown>
): NodeReservedValue {
  if (SOLANA_DECLARED_VALUE_STEPS.has(stepFunction)) {
    const declared = typeof config.maxSol === "string" ? config.maxSol : "";
    if (declared.trim() === "") {
      return {
        ok: false,
        error:
          "maxSol is required for this action: declare the maximum SOL the transaction may move so it can be charged against the organization's daily Solana value cap",
      };
    }
    const parsed = parseNativeValueLamports(declared);
    return parsed.ok
      ? { ok: true, kind: "solana", valueLamports: parsed.valueWei }
      : parsed;
  }

  // An SPL transfer moves no native SOL of its own, so what is charged is its
  // SOL cost: the signature fee plus rent for a token account the recipient may
  // not have yet. The reservation runs without a chain read, so it charges a
  // fixed worst case; transfer-spl-token-core reads the mint's real rent and
  // refuses to exceed this figure.
  if (stepFunction === "transferSplTokenStep") {
    if (!isSolanaNetwork(config.network)) {
      return { ok: false, error: "transfer-spl-token is Solana-only" };
    }
    return {
      ok: true,
      kind: "solana",
      valueLamports: SOLANA_SPL_MAX_FEE_LAMPORTS.toString(),
    };
  }

  // transferFundsStep is chain-agnostic - transfer-funds-core branches to a
  // Solana path on a Solana chainId - so the amount's unit depends on the
  // configured network, not on the step name. Without this a native SOL
  // transfer would be parsed at 18 decimals and charged to the wei cap.
  if (stepFunction === "transferFundsStep") {
    const amount =
      typeof config.amount === "string" ? config.amount : undefined;
    if (isSolanaNetwork(config.network)) {
      const parsed = parseNativeValueLamports(amount);
      return parsed.ok
        ? { ok: true, kind: "solana", valueLamports: parsed.valueWei }
        : parsed;
    }
    const parsed = parseNativeValueWei(amount);
    return parsed.ok
      ? { ok: true, kind: "evm", valueWei: parsed.valueWei }
      : parsed;
  }

  const parsed = parseNativeValueWei(
    typeof config.ethValue === "string" ? config.ethValue : undefined
  );
  return parsed.ok
    ? { ok: true, kind: "evm", valueWei: parsed.valueWei }
    : parsed;
}

/**
 * Whether a config `network` value denotes a Solana chain. Unresolvable or
 * absent networks fall through to EVM, matching how the rest of the reservation
 * path treats an unknown chain.
 */
export function isSolanaNetwork(network: unknown): boolean {
  if (typeof network !== "string" || network.trim() === "") {
    return false;
  }
  const chainId = getChainIdFromNetwork(network);
  return typeof chainId === "number" && isSolanaChain(chainId);
}
