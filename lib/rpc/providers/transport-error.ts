import { ExecutionErrorType } from "@/lib/errors/execution-error-type";
import { isOrgRpcError } from "../engine/org-rpc-error";

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
 * The fault domain an RPC failure declares, or undefined when it declares
 * none (the caller keeps its own classification). A relay transport failure
 * and a failure on an organization's own endpoints are both external.
 */
export function rpcRelayErrorClass(
  error: unknown
): ExecutionErrorType | undefined {
  if (error instanceof RpcRelayTransportError) {
    return error.errorClass;
  }
  return isOrgRpcError(error) ? ExecutionErrorType.EXTERNAL : undefined;
}
