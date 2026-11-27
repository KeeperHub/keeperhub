import { createHash } from "node:crypto";
import { RpcRouteError, RpcRouteErrorCode } from "./route-error";
import {
  FINGERPRINT_ENCODING,
  FINGERPRINT_HASH,
  type SecretUrl,
} from "./secret-url";
import {
  type OrgRpcConfig,
  type OrgRpcState,
  type PlatformEndpoints,
  type PrivateMempoolRequest,
  type RpcChain,
  RpcChainType,
  type RpcEndpoint,
  RpcEndpointRole,
  RpcOrigin,
  RpcPurpose,
  type RpcRoute,
  RpcRouteNotice,
  type RpcScope,
  RpcScopeKind,
  type RpcSelection,
  RpcSelectionMode,
} from "./types";

/** Hex characters kept from the route fingerprint. */
const ROUTE_KEY_LENGTH = 32;

export type ResolveRouteInput = {
  chainId: number;
  scope: RpcScope;
  chain: RpcChain | null;
  platform: PlatformEndpoints | null;
  org: OrgRpcState;
  purpose: RpcPurpose;
  /** Only honoured for `RpcPurpose.WRITE`. */
  privateMempool?: PrivateMempoolRequest;
};

export type ResolveRouteResult =
  | { ok: true; route: RpcRoute }
  | { ok: false; error: RpcRouteError };

type RouteParts = {
  primary: RpcEndpoint;
  fallback?: RpcEndpoint;
  notices: RpcRouteNotice[];
};

type PartsResult =
  | { ok: true; parts: RouteParts }
  | { ok: false; error: RpcRouteError };

type ConfigChoice =
  | { ok: true; config: OrgRpcConfig | null }
  | { ok: false; error: RpcRouteError };

type ResolvedChain = { chain: RpcChain; platform: PlatformEndpoints };

function fail(error: RpcRouteError): { ok: false; error: RpcRouteError } {
  return { ok: false, error };
}

function platformEndpoint(url: SecretUrl, role: RpcEndpointRole): RpcEndpoint {
  return {
    origin: RpcOrigin.PLATFORM,
    role,
    transport: url.transport,
    url,
    configId: null,
    configName: null,
  };
}

function orgEndpoint(
  config: OrgRpcConfig,
  url: SecretUrl,
  role: RpcEndpointRole
): RpcEndpoint {
  return {
    origin: RpcOrigin.ORG,
    role,
    transport: url.transport,
    url,
    configId: config.id,
    configName: config.name,
  };
}

/**
 * Pick the organization config a scope resolves to. `null` means the route
 * comes from KeeperHub's endpoints.
 */
function chooseConfig(
  selection: RpcSelection,
  state: OrgRpcState,
  chainId: number
): ConfigChoice {
  const { ownRpcOnly } = state.policy;

  if (selection.mode === RpcSelectionMode.PLATFORM) {
    return ownRpcOnly
      ? fail(new RpcRouteError(RpcRouteErrorCode.PLATFORM_FORBIDDEN, chainId))
      : { ok: true, config: null };
  }

  if (selection.mode === RpcSelectionMode.CONFIG) {
    const config = state.configs.find((c) => c.id === selection.configId);
    if (!config) {
      return fail(
        new RpcRouteError(RpcRouteErrorCode.CONFIG_NOT_FOUND, chainId)
      );
    }
    if (config.chainId !== chainId) {
      return fail(
        new RpcRouteError(RpcRouteErrorCode.CONFIG_CHAIN_MISMATCH, chainId)
      );
    }
    if (!config.enabled) {
      return fail(
        new RpcRouteError(RpcRouteErrorCode.CONFIG_DISABLED, chainId)
      );
    }
    return { ok: true, config };
  }

  const defaultConfig = state.configs.find(
    (c) => c.chainId === chainId && c.isDefault && c.enabled
  );
  if (defaultConfig) {
    return { ok: true, config: defaultConfig };
  }
  return ownRpcOnly
    ? fail(new RpcRouteError(RpcRouteErrorCode.NOT_COVERED, chainId))
    : { ok: true, config: null };
}

function platformHttpParts(platform: PlatformEndpoints): RouteParts {
  return {
    primary: platformEndpoint(platform.httpPrimary, RpcEndpointRole.PRIMARY),
    fallback: platform.httpFallback
      ? platformEndpoint(platform.httpFallback, RpcEndpointRole.FALLBACK)
      : undefined,
    notices: [],
  };
}

function platformSubscribeParts({
  chain,
  platform,
}: ResolvedChain): PartsResult {
  if (chain.chainType === RpcChainType.SOLANA) {
    return { ok: true, parts: platformHttpParts(platform) };
  }
  if (!platform.wssPrimary) {
    return fail(
      new RpcRouteError(RpcRouteErrorCode.NO_SUBSCRIBE_ENDPOINT, chain.chainId)
    );
  }
  return {
    ok: true,
    parts: {
      primary: platformEndpoint(platform.wssPrimary, RpcEndpointRole.PRIMARY),
      fallback: platform.wssFallback
        ? platformEndpoint(platform.wssFallback, RpcEndpointRole.FALLBACK)
        : undefined,
      notices: [],
    },
  };
}

/**
 * Put a private endpoint in front of `publicPrimary`. Strict keeps the
 * private endpoint alone so a failure never leaks the transaction to the
 * public mempool.
 */
function withPrivatePrimary(
  privateEndpoint: RpcEndpoint,
  publicPrimary: RpcEndpoint,
  request: PrivateMempoolRequest
): RouteParts {
  return {
    primary: privateEndpoint,
    fallback: request.strict ? undefined : publicPrimary,
    notices: [],
  };
}

function unsupportedPrivate(parts: RouteParts): RouteParts {
  return {
    ...parts,
    notices: [...parts.notices, RpcRouteNotice.PRIVATE_MEMPOOL_UNSUPPORTED],
  };
}

function platformParts(
  resolved: ResolvedChain,
  purpose: RpcPurpose,
  privateMempool: PrivateMempoolRequest | undefined
): PartsResult {
  if (purpose === RpcPurpose.SUBSCRIBE) {
    return platformSubscribeParts(resolved);
  }
  const http = platformHttpParts(resolved.platform);
  if (!privateMempool) {
    return { ok: true, parts: http };
  }
  const { privateTx } = resolved.platform;
  if (!privateTx) {
    return { ok: true, parts: unsupportedPrivate(http) };
  }
  return {
    ok: true,
    parts: withPrivatePrimary(
      platformEndpoint(privateTx, RpcEndpointRole.PRIVATE),
      http.primary,
      privateMempool
    ),
  };
}

function configHttpParts(
  config: OrgRpcConfig,
  platform: PlatformEndpoints,
  ownRpcOnly: boolean
): RouteParts {
  let fallback: RpcEndpoint | undefined;
  if (config.httpFallback) {
    fallback = orgEndpoint(
      config,
      config.httpFallback,
      RpcEndpointRole.FALLBACK
    );
  } else if (!ownRpcOnly) {
    fallback = platformEndpoint(platform.httpPrimary, RpcEndpointRole.PRIMARY);
  }
  return {
    primary: orgEndpoint(config, config.httpPrimary, RpcEndpointRole.PRIMARY),
    fallback,
    notices: [],
  };
}

function configSubscribeParts(
  resolved: ResolvedChain,
  config: OrgRpcConfig,
  ownRpcOnly: boolean
): PartsResult {
  const { chain, platform } = resolved;
  if (chain.chainType === RpcChainType.SOLANA) {
    return { ok: true, parts: configHttpParts(config, platform, ownRpcOnly) };
  }
  if (!config.wssPrimary) {
    return ownRpcOnly
      ? fail(new RpcRouteError(RpcRouteErrorCode.NOT_COVERED, chain.chainId))
      : platformSubscribeParts(resolved);
  }
  let fallback: RpcEndpoint | undefined;
  if (config.wssFallback) {
    fallback = orgEndpoint(
      config,
      config.wssFallback,
      RpcEndpointRole.FALLBACK
    );
  } else if (!ownRpcOnly && platform.wssPrimary) {
    fallback = platformEndpoint(platform.wssPrimary, RpcEndpointRole.PRIMARY);
  }
  return {
    ok: true,
    parts: {
      primary: orgEndpoint(config, config.wssPrimary, RpcEndpointRole.PRIMARY),
      fallback,
      notices: [],
    },
  };
}

function configParts(
  resolved: ResolvedChain,
  config: OrgRpcConfig,
  purpose: RpcPurpose,
  privateMempool: PrivateMempoolRequest | undefined,
  ownRpcOnly: boolean
): PartsResult {
  if (purpose === RpcPurpose.SUBSCRIBE) {
    return configSubscribeParts(resolved, config, ownRpcOnly);
  }
  const http = configHttpParts(config, resolved.platform, ownRpcOnly);
  if (!privateMempool) {
    return { ok: true, parts: http };
  }
  if (config.privateTx) {
    return {
      ok: true,
      parts: withPrivatePrimary(
        orgEndpoint(config, config.privateTx, RpcEndpointRole.PRIVATE),
        http.primary,
        privateMempool
      ),
    };
  }
  if (ownRpcOnly) {
    return fail(
      new RpcRouteError(
        RpcRouteErrorCode.NO_PRIVATE_URL,
        resolved.chain.chainId
      )
    );
  }
  const relay = resolved.platform.privateTx;
  if (!relay) {
    return { ok: true, parts: unsupportedPrivate(http) };
  }
  return {
    ok: true,
    parts: withPrivatePrimary(
      platformEndpoint(relay, RpcEndpointRole.PRIVATE),
      http.primary,
      privateMempool
    ),
  };
}

function endpointIdentity(
  endpoint: RpcEndpoint | undefined
): (string | null)[] {
  if (!endpoint) {
    return [];
  }
  return [
    endpoint.origin,
    endpoint.role,
    endpoint.configId,
    endpoint.url.fingerprint,
  ];
}

function routeKey(
  chainId: number,
  organizationId: string | null,
  parts: RouteParts
): string {
  const identity = JSON.stringify([
    chainId,
    organizationId,
    endpointIdentity(parts.primary),
    endpointIdentity(parts.fallback),
  ]);
  return createHash(FINGERPRINT_HASH)
    .update(identity)
    .digest(FINGERPRINT_ENCODING)
    .slice(0, ROUTE_KEY_LENGTH);
}

/**
 * Decide which endpoints serve a call. This is the only place that knows the
 * precedence rules: node selection, the organization's default config per
 * chain, the fallback slot, "own RPC only" and private mempool routing. It
 * does no I/O, so every rule is covered by plain unit tests.
 */
export function resolveRoute(input: ResolveRouteInput): ResolveRouteResult {
  const { chainId, scope, chain, platform, org, purpose } = input;
  if (!(chain?.isEnabled && platform)) {
    return fail(
      new RpcRouteError(RpcRouteErrorCode.CHAIN_UNAVAILABLE, chainId)
    );
  }
  const resolved: ResolvedChain = { chain, platform };
  const privateMempool =
    purpose === RpcPurpose.WRITE ? input.privateMempool : undefined;

  let organizationId: string | null = null;
  let ownRpcOnly = false;
  let partsResult: PartsResult;

  if (scope.kind === RpcScopeKind.PLATFORM) {
    partsResult = platformParts(resolved, purpose, privateMempool);
  } else {
    organizationId = scope.organizationId;
    ownRpcOnly = org.policy.ownRpcOnly;
    const choice = chooseConfig(scope.selection, org, chainId);
    if (!choice.ok) {
      return choice;
    }
    partsResult = choice.config
      ? configParts(
          resolved,
          choice.config,
          purpose,
          privateMempool,
          ownRpcOnly
        )
      : platformParts(resolved, purpose, privateMempool);
  }

  if (!partsResult.ok) {
    return partsResult;
  }
  const { parts } = partsResult;
  return {
    ok: true,
    route: {
      key: routeKey(chainId, organizationId, parts),
      chain,
      transport: parts.primary.transport,
      primary: parts.primary,
      fallback: parts.fallback,
      organizationId,
      ownRpcOnly,
      notices: parts.notices,
    },
  };
}
