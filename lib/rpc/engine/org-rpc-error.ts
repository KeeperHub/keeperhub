import { findInErrorChain } from "@/lib/errors/cause-chain";

/** Survives duplicated module copies, unlike an instanceof check. */
const ORG_RPC_ERROR_BRAND = Symbol.for("keeperhub.rpc.orgRpcError");

/**
 * A failure on an organization's own RPC endpoint. Its message is already
 * redacted for the person running the workflow. Platform telemetry drops it
 * entirely: what happens on an organization's endpoint is its business, and
 * it is recorded in that organization's usage store instead.
 */
export class OrgRpcError extends Error {
  readonly [ORG_RPC_ERROR_BRAND] = true;

  constructor(message: string) {
    super(message);
    this.name = OrgRpcError.name;
  }
}

function hasBrand(candidate: object): boolean {
  return (candidate as Record<symbol, unknown>)[ORG_RPC_ERROR_BRAND] === true;
}

/** True when the error, or anything in its cause chain, is an OrgRpcError. */
export function isOrgRpcError(error: unknown): boolean {
  return findInErrorChain(error, hasBrand) !== undefined;
}
