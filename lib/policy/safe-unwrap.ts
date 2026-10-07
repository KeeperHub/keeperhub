import { ethers } from "ethers";
import { selectorOf } from "@/lib/policy/intent-digest";

/**
 * A Safe forwards a call, so the transaction a signer sees names the Safe and
 * not the address the money reaches.
 *
 * Without unwrapping, routing through a Safe is a way around every rule about
 * a target: the outer call is `execTransaction` on the Safe, and a deny naming
 * the real contract never matches it.
 */
const EXEC_TRANSACTION =
  "function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures)";

const EXEC_FROM_MODULE =
  "function execTransactionFromModule(address to, uint256 value, bytes data, uint8 operation)";

const EXEC_FROM_MODULE_RETURN =
  "function execTransactionFromModuleReturnData(address to, uint256 value, bytes data, uint8 operation)";

/** The Zodiac Roles modifier wraps a call the same way. */
const EXEC_WITH_ROLE =
  "function execTransactionWithRole(address to, uint256 value, bytes data, uint8 operation, bytes32 roleKey, bool shouldRevert)";

const FORWARDERS = new ethers.Interface([
  EXEC_TRANSACTION,
  EXEC_FROM_MODULE,
  EXEC_FROM_MODULE_RETURN,
  EXEC_WITH_ROLE,
]);

const FORWARDER_SELECTORS = new Set(
  FORWARDERS.fragments
    .filter((fragment): fragment is ethers.FunctionFragment =>
      ethers.FunctionFragment.isFunction(fragment)
    )
    .map((fragment) => fragment.selector.toLowerCase())
);

export type ForwardedCall = {
  to: string;
  selector: string;
  valueWei: string;
};

/** Whether calldata is one of the wrappers that forwards to another address. */
export function isForwarder(data: string | undefined | null): boolean {
  return FORWARDER_SELECTORS.has(selectorOf(data));
}

/**
 * The call a forwarder carries, or null when there is none to read.
 *
 * Only one level is unwrapped. A forwarder whose inner call is itself a
 * forwarder is refused rather than followed, because each hop is another
 * chance to lose track of what is really being called.
 */
export function unwrapForwardedCall(
  data: string | undefined | null
): ForwardedCall | null {
  if (!(data && isForwarder(data))) {
    return null;
  }
  try {
    const parsed = FORWARDERS.parseTransaction({ data });
    if (!parsed) {
      return null;
    }
    const to = parsed.args[0] as string;
    const value = parsed.args[1] as bigint;
    const inner = parsed.args[2] as string;
    return {
      to,
      selector: selectorOf(inner),
      valueWei: value.toString(),
    };
  } catch {
    // Calldata that will not decode is left alone. The outer call is still
    // checked, so nothing is skipped by failing to read the inner one.
    return null;
  }
}
