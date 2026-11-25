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
    `Your organization only allows its own RPC endpoints, and none is set up for chain ${chainId} for this kind of call.`,
  [RpcRouteErrorCode.PLATFORM_FORBIDDEN]: () =>
    "Your organization only allows its own RPC endpoints, so the KeeperHub default cannot be used.",
  [RpcRouteErrorCode.NO_PRIVATE_URL]: (chainId) =>
    `Your organization only allows its own RPC endpoints, and no private transaction URL is set up for chain ${chainId}.`,
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
