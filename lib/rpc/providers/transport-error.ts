import { ExecutionErrorType } from "@/lib/errors/execution-error-type";

/**
 * Failover exhausted against the chain's private-mempool relay (Flashbots
 * Protect and friends), with every attempt failing on transport.
 *
 * Every other endpoint we route to is one we run: chain defaults point at
 * env-configured infrastructure, so their failures are ours to answer for and
 * stay `system`. The relay is a pointer we configure and a node we do not
 * operate, which makes it a third-party dependency.
 *
 * `errorClass` lets the step that catches this hand the executor an
 * authoritative classification instead of leaving the message classifier to
 * infer one from prose, which reads every `RPC failed ...` string as a
 * platform fault.
 */
export class RpcRelayTransportError extends Error {
  override readonly name = "RpcRelayTransportError" as const;
  readonly errorClass = ExecutionErrorType.EXTERNAL;
}

/**
 * The fault domain an RPC failure declares, or undefined for anything that is
 * not a relay transport failure (the caller keeps its own classification).
 */
export function rpcRelayErrorClass(
  error: unknown
): ExecutionErrorType | undefined {
  return error instanceof RpcRelayTransportError ? error.errorClass : undefined;
}
