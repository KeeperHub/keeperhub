import { isConnectionRefusal } from "@/lib/rpc/connection-refusal";
import type { RpcProviderManager } from "@/lib/rpc/providers";
import {
  classifyRpcError,
  type Delivery,
  isDuplicateMessage,
} from "@/lib/web3/json-rpc-answer";
import { rpcErrorOf } from "@/lib/web3/revert-data";

/** Where a write was broadcast. Reported as the step's `route` output. */
export type SendRoute = "public" | "private-relay" | "sponsored";

/** Filled in while a write is sent; `included` once a receipt is seen. */
export type SendReport = { route?: SendRoute; included?: boolean };

/** One broadcast to a managed endpoint and what became of it. */
export type Attempt = { route: SendRoute; delivery: Delivery };

/**
 * How a managed endpoint's broadcast error reads, for the route only.
 * `knownRefusal` is the caller's own verdict (refused connection, nonce
 * conflict), passed in so this module does not import the send helper.
 */
export function deliveryOfBroadcastError(
  error: unknown,
  message: string,
  knownRefusal: boolean
): Delivery {
  if (isDuplicateMessage(message)) {
    return "accepted";
  }
  if (knownRefusal || isConnectionRefusal(error)) {
    return "refused";
  }
  const rpcError = rpcErrorOf(error);
  return rpcError ? classifyRpcError(rpcError) : "unknown";
}

/**
 * Route for a send the managed endpoints did not accept outright: public
 * when a public endpoint took or may have taken the bytes, then the relay
 * once it took them (an answer, or the hash found after no clear answer).
 * When nobody did but the hash exists anyway, fall back to the manager's
 * own route. Undefined means no endpoint is known to hold the transaction.
 */
export function routeFromEvidence(
  rpcManager: RpcProviderManager,
  attempts: readonly Attempt[],
  extraDeliveries: readonly Delivery[],
  found: boolean
): SendRoute | undefined {
  const delivered = (delivery: Delivery): boolean => delivery !== "refused";
  if (
    extraDeliveries.some(delivered) ||
    attempts.some((a) => a.route === "public" && delivered(a.delivery))
  ) {
    return "public";
  }
  // "private-relay" says the relay accepted it: a pending send it never answered is not that.
  const relayTook = (delivery: Delivery): boolean =>
    delivery === "accepted" || (found && delivery === "unknown");
  if (
    attempts.some((a) => a.route === "private-relay" && relayTook(a.delivery))
  ) {
    return "private-relay";
  }
  if (!found) {
    return;
  }
  const publicTried =
    extraDeliveries.length > 0 || attempts.some((a) => a.route === "public");
  return rpcManager.hasPrivateRelayPrimary() && !publicTried
    ? "private-relay"
    : "public";
}
