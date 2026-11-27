export const RpcRouteErrorCode = {
  CHAIN_UNAVAILABLE: "CHAIN_UNAVAILABLE",
  CONFIG_NOT_FOUND: "CONFIG_NOT_FOUND",
  CONFIG_CHAIN_MISMATCH: "CONFIG_CHAIN_MISMATCH",
  CONFIG_DISABLED: "CONFIG_DISABLED",
  NOT_COVERED: "NOT_COVERED",
  PLATFORM_FORBIDDEN: "PLATFORM_FORBIDDEN",
  NO_PRIVATE_URL: "NO_PRIVATE_URL",
  NO_SUBSCRIBE_ENDPOINT: "NO_SUBSCRIBE_ENDPOINT",
  WRONG_CHAIN_FAMILY: "WRONG_CHAIN_FAMILY",
} as const;
export type RpcRouteErrorCode =
  (typeof RpcRouteErrorCode)[keyof typeof RpcRouteErrorCode];

/**
 * Refusals caused by the organization's own RPC settings: a pinned config
 * that cannot serve, or "own RPC only" without a fitting config. The other
 * codes come from KeeperHub's chain setup, which no organization config can
 * fix, so coverage checks and trigger routing ignore them.
 */
export const ORG_SETTING_ROUTE_ERRORS: ReadonlySet<RpcRouteErrorCode> = new Set(
  [
    RpcRouteErrorCode.CONFIG_NOT_FOUND,
    RpcRouteErrorCode.CONFIG_CHAIN_MISMATCH,
    RpcRouteErrorCode.CONFIG_DISABLED,
    RpcRouteErrorCode.NOT_COVERED,
    RpcRouteErrorCode.PLATFORM_FORBIDDEN,
    RpcRouteErrorCode.NO_PRIVATE_URL,
  ]
);

const MESSAGES: Record<RpcRouteErrorCode, (chainId: number) => string> = {
  [RpcRouteErrorCode.CHAIN_UNAVAILABLE]: (chainId) =>
    `Chain ${chainId} is not supported or is disabled`,
  [RpcRouteErrorCode.CONFIG_NOT_FOUND]: () =>
    "The selected RPC configuration no longer exists. Pick another one on this step.",
  [RpcRouteErrorCode.CONFIG_CHAIN_MISMATCH]: (chainId) =>
    `The selected RPC configuration is not for chain ${chainId}. Pick one for this network.`,
  [RpcRouteErrorCode.CONFIG_DISABLED]: () =>
    "The selected RPC configuration is disabled. Enable it or pick another one.",
  [RpcRouteErrorCode.NOT_COVERED]: (chainId) =>
    `Chain ${chainId} is set to use only your organization's endpoints, and none of them can serve this kind of call. Add one in Settings > RPC endpoints.`,
  [RpcRouteErrorCode.PLATFORM_FORBIDDEN]: () =>
    "This network is set to use only your organization's endpoints, so the KeeperHub default cannot be used.",
  [RpcRouteErrorCode.NO_PRIVATE_URL]: (chainId) =>
    `Chain ${chainId} is set to use only your organization's endpoints, and none of them has a private transaction URL.`,
  [RpcRouteErrorCode.NO_SUBSCRIBE_ENDPOINT]: (chainId) =>
    `No WebSocket endpoint is configured for chain ${chainId}.`,
  [RpcRouteErrorCode.WRONG_CHAIN_FAMILY]: (chainId) =>
    `Chain ${chainId} does not support this kind of client.`,
};

/**
 * Why a route could not be resolved. The message is written for the person
 * running the workflow and never names an endpoint.
 */
export class RpcRouteError extends Error {
  readonly code: RpcRouteErrorCode;
  readonly chainId: number;

  constructor(code: RpcRouteErrorCode, chainId: number) {
    super(MESSAGES[code](chainId));
    this.name = RpcRouteError.name;
    this.code = code;
    this.chainId = chainId;
  }
}

/**
 * True for a refusal the organization's own RPC settings caused, which the
 * person running the workflow can fix; false for any other error, including
 * a route refused by KeeperHub's own chain setup.
 */
export function isOrgSettingRouteError(error: unknown): boolean {
  return (
    error instanceof RpcRouteError && ORG_SETTING_ROUTE_ERRORS.has(error.code)
  );
}
