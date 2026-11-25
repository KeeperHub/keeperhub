import { getRpcProvider } from "@/lib/rpc/provider-factory";
import {
  InvalidSendModeError,
  PrivateRelayUnavailableError,
  type RpcProviderManager,
} from "@/lib/rpc/providers";
import { relayUseOf, unknownSendModeIssue } from "@/lib/web3/send-mode";

type SendAsInput = {
  sendMode?: unknown;
  usePrivateMempool?: unknown;
  strict?: boolean;
};

export type SendRpc = {
  rpcManager: RpcProviderManager;
  /** The step asked for the relay and may use it: never sponsored. */
  relayRequested: boolean;
};

/**
 * The manager a write step sends through. Before anything is sent it refuses an
 * unknown `sendMode`, a relay the chain or step (`relayRefusal`) cannot use, or one serving another chain.
 */
export async function getSendRpcProvider(
  input: SendAsInput,
  options: { chainId: number; userId?: string; relayRefusal?: string }
): Promise<SendRpc> {
  const invalid = unknownSendModeIssue(input.sendMode);
  if (invalid) {
    throw new InvalidSendModeError(invalid);
  }
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
  const onRelay = relay !== "none" && rpcManager.hasPrivateRelayPrimary();
  if (onRelay && options.relayRefusal) {
    throw new PrivateRelayUnavailableError(options.relayRefusal);
  }
  if (onRelay) {
    await rpcManager.assertPrivateRelayChain();
  }
  return { rpcManager, relayRequested: relay === "required" || onRelay };
}
