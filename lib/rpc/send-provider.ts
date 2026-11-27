import type { ExecutionErrorType } from "@/lib/errors/execution-error-type";
import { ErrorCategory, logUserError } from "@/lib/logging";
import { getRpcProvider } from "@/lib/rpc/provider-factory";
import {
  InvalidSendModeError,
  PrivateRelayUnavailableError,
  type RpcProviderManager,
  rpcRelayErrorClass,
} from "@/lib/rpc/providers";
import { readRpcFor } from "@/lib/rpc/read-provider";
import { getErrorMessage } from "@/lib/utils";
import {
  noPrivateRelayMessage,
  relayUseOf,
  resolveSendMode,
  SEND_MODE,
  USE_NORMAL_HINT,
  unknownSendModeIssue,
} from "@/lib/web3/send-mode";

type SendAsInput = {
  sendMode?: unknown;
  usePrivateMempool?: unknown;
  strict?: boolean;
};

type SendRpc = {
  rpcManager: RpcProviderManager;
  /** The step asked for the relay (Send as or the old flag): never sponsored, as before. */
  relayRequested: boolean;
  /** Send as Bundle: the manager only reads; the step sends to block builders. */
  bundleRequested: boolean;
};

/** Send as Bundle on a step that cannot send one; never sent publicly instead. */
const BUNDLE_REFUSAL = `This step is set to Send as: Bundle, but bundles are only available on Write Contract steps. ${USE_NORMAL_HINT}`;

function refuseUnknownOrBundle(input: SendAsInput, allowBundle: boolean): void {
  const invalid = unknownSendModeIssue(input.sendMode);
  if (invalid) {
    throw new InvalidSendModeError(invalid);
  }
  if (!allowBundle && resolveSendMode(input) === SEND_MODE.BUNDLE) {
    throw new InvalidSendModeError(BUNDLE_REFUSAL);
  }
}

/**
 * The manager a write step sends through. Before anything is sent it refuses an
 * unknown `sendMode`, a bundle unless `allowBundle`, a relay the chain cannot offer,
 * `sendMode: "private-relay"` on a step that cannot use it (`relayRefusal`), or a
 * relay serving another chain.
 * The old flag alone uses the relay where the chain has one, on any step, as before.
 */
export async function getSendRpcProvider(
  input: SendAsInput,
  options: {
    chainId: number;
    userId?: string;
    relayRefusal?: string;
    allowBundle?: boolean;
  }
): Promise<SendRpc> {
  refuseUnknownOrBundle(input, options.allowBundle === true);
  const relay = relayUseOf(input);
  if (relay === "required" && options.relayRefusal) {
    throw new PrivateRelayUnavailableError(options.relayRefusal);
  }
  const rpcManager = await getRpcProvider({
    chainId: options.chainId,
    userId: options.userId,
    usePrivateMempool: relay !== "none",
    strict: input.strict,
    relayOptional: relay === "if-available",
  });
  if (relay !== "none" && rpcManager.hasPrivateRelayPrimary()) {
    await rpcManager.assertPrivateRelayChain();
  }
  return {
    rpcManager,
    relayRequested: relay !== "none",
    bundleRequested: resolveSendMode(input) === SEND_MODE.BUNDLE,
  };
}

/** The Send as checks on a chain that has no relay at all (Solana). */
export function assertSendAsWithoutRelay(
  input: SendAsInput,
  chainName: string
): void {
  refuseUnknownOrBundle(input, false);
  if (relayUseOf(input) === "required" && input.strict !== false) {
    throw new PrivateRelayUnavailableError(noPrivateRelayMessage(chainName));
  }
}

type WriteRpc = SendRpc & { rpcUrl: string };

type ReadingWriteRpc = WriteRpc & {
  /** Reads with no transaction data (token reads, the trace); the send stays on rpcManager. */
  readRpc: RpcProviderManager;
};

type WriteRpcFailure = { error: string; errorClass?: ExecutionErrorType };

type WriteRpcResult<T> =
  | { ok: true; rpc: T }
  | { ok: false; failure: WriteRpcFailure };

type WriteRpcOptions = {
  chainId: number;
  userId?: string;
  relayRefusal?: string;
  allowBundle?: boolean;
  log: { tag: string; action: string };
  fallbackClass?: ExecutionErrorType;
  /** Also resolve `readRpc`; only steps that read with it ask, so others never fail on it. */
  withReadRpc?: boolean;
};

/**
 * Everything a write step's send needs from the RPC layer. A failure is logged
 * and returned with its class: the relay's own, else `fallbackClass`.
 */
export function resolveWriteRpc(
  input: SendAsInput,
  options: WriteRpcOptions & { withReadRpc: true }
): Promise<WriteRpcResult<ReadingWriteRpc>>;
export function resolveWriteRpc(
  input: SendAsInput,
  options: WriteRpcOptions
): Promise<WriteRpcResult<WriteRpc>>;
export async function resolveWriteRpc(
  input: SendAsInput,
  options: WriteRpcOptions
): Promise<WriteRpcResult<WriteRpc | ReadingWriteRpc>> {
  try {
    const send = await getSendRpcProvider(input, options);
    const rpcUrl = await send.rpcManager.resolveActiveRpcUrl();
    if (!options.withReadRpc) {
      return { ok: true, rpc: { ...send, rpcUrl } };
    }
    const readRpc = await readRpcFor(send.rpcManager, options);
    return { ok: true, rpc: { ...send, readRpc, rpcUrl } };
  } catch (error) {
    logUserError(
      ErrorCategory.VALIDATION,
      `${options.log.tag} Failed to resolve RPC config`,
      error,
      {
        plugin_name: "web3",
        action_name: options.log.action,
        chain_id: String(options.chainId),
      }
    );
    const errorClass = rpcRelayErrorClass(error) ?? options.fallbackClass;
    return {
      ok: false,
      failure: {
        error: getErrorMessage(error),
        ...(errorClass ? { errorClass } : {}),
      },
    };
  }
}
