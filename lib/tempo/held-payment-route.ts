import "server-only";

import {
  parseRpcSelection,
  RpcRouteError,
  RpcRouteErrorCode,
  type RpcScope,
  rpcScopeForOrganization,
} from "@/lib/rpc/engine";

/** Refusals meaning the config the payment was signed on is no longer usable. */
const GONE_CONFIG_ERRORS: ReadonlySet<RpcRouteErrorCode> = new Set([
  RpcRouteErrorCode.CONFIG_NOT_FOUND,
  RpcRouteErrorCode.CONFIG_DISABLED,
  RpcRouteErrorCode.CONFIG_CHAIN_MISMATCH,
]);

/**
 * Run a held payment's RPC work on the route its signing node chose. The
 * payment is already signed and can outlive that node's config: when the
 * config has since been deleted or disabled, the work runs on Auto instead,
 * which own RPC only still keeps on the organization's endpoints. The route
 * is resolved before anything is sent, so the retry never sends twice.
 */
export async function onHeldPaymentRoute<T>(
  organizationId: string,
  rpcSelection: string | null,
  run: (scope: RpcScope) => Promise<T>
): Promise<T> {
  try {
    return await run(
      rpcScopeForOrganization(organizationId, parseRpcSelection(rpcSelection))
    );
  } catch (error) {
    if (
      rpcSelection !== null &&
      error instanceof RpcRouteError &&
      GONE_CONFIG_ERRORS.has(error.code)
    ) {
      return await run(rpcScopeForOrganization(organizationId));
    }
    throw error;
  }
}
