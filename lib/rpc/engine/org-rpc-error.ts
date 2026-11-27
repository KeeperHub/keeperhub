import { findInErrorChain } from "@/lib/errors/cause-chain";
import { ExecutionErrorType } from "@/lib/errors/execution-error-type";
import { redactOrganizationHosts } from "./organization-hosts";

/**
 * Leads every OrgRpcError message, so a failure that only survives as text
 * (step results, run errors) is still told apart from a KeeperHub outage.
 */
export const ORG_RPC_FAILURE_PREFIX = "Organization";

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
  /** An endpoint the organization chose, not one KeeperHub runs. */
  readonly errorClass = ExecutionErrorType.EXTERNAL;

  constructor(message: string) {
    // URLs are already gone; a bare hostname, as DNS errors give, goes too.
    super(`${ORG_RPC_FAILURE_PREFIX} ${redactOrganizationHosts(message)}`);
    this.name = OrgRpcError.name;
  }
}

/**
 * Mark an error thrown by a library on an organization's endpoint as that
 * organization's, keeping its own class so the library's handling still works.
 */
export function markOrgRpcError(error: object): void {
  Object.defineProperty(error, ORG_RPC_ERROR_BRAND, { value: true });
}

function hasBrand(candidate: object): boolean {
  return (candidate as Record<symbol, unknown>)[ORG_RPC_ERROR_BRAND] === true;
}

/** True when the error, or anything in its cause chain, is an OrgRpcError. */
export function isOrgRpcError(error: unknown): boolean {
  return findInErrorChain(error, hasBrand) !== undefined;
}
