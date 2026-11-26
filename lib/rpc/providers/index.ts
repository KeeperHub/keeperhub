import { ethers, isError } from "ethers";
import { sleep } from "@/lib/sleep";
import { OrgRpcError } from "../engine/org-rpc-error";
import { collectorFromSink } from "../engine/telemetry/collector-adapter";
import { createPlatformSink } from "../engine/telemetry/platform-sink";
import {
  RpcErrorType,
  RpcOperationType,
  RpcTelemetryEventType,
  type RpcTelemetrySink,
} from "../engine/telemetry/sink";
import { RpcChainType, RpcOrigin, RpcRoutePosition } from "../engine/types";
import { safeEthersGetUrl } from "../safe-ethers-fetch";
import { redactAllUrls, scrubRpcUrls } from "../scrub-rpc-urls";
import { BoundedCache } from "./bounded-cache";
import {
  isNonRetryableError,
  isTransportFailure,
  RPC_CONNECTION_ERROR_PATTERNS,
} from "./error-classification";
import { RpcRelayTransportError } from "./transport-error";

export {
  RpcErrorType,
  RpcOperationType,
} from "../engine/telemetry/sink";
export {
  isNonRetryableError,
  isTransportFailure,
  NON_RETRYABLE_ERROR_CODES,
  RPC_CONNECTION_ERROR_PATTERNS,
} from "./error-classification";
export { RpcRelayTransportError, rpcRelayErrorClass } from "./transport-error";

/**
 * Interface for metrics collection - allows dependency injection
 * so both server-side (console/structured) and frontend (no-op) can use this
 */
export type RpcMetricsCollector = {
  recordPrimaryAttempt(chainName: string, operation?: RpcOperationType): void;
  recordPrimaryFailure(chainName: string, operation?: RpcOperationType): void;
  recordFallbackAttempt(chainName: string, operation?: RpcOperationType): void;
  recordFallbackFailure(chainName: string, operation?: RpcOperationType): void;
  recordFailoverEvent(chainName: string): void;
  recordRecoveryEvent(chainName: string): void;
  recordBothFailed(chainName: string): void;
  recordSuccess(
    chainName: string,
    provider: RpcRoutePosition,
    operation?: RpcOperationType
  ): void;
  recordLatency(
    chainName: string,
    provider: RpcRoutePosition,
    durationMs: number,
    operation?: RpcOperationType
  ): void;
  recordErrorType(
    chainName: string,
    provider: RpcRoutePosition,
    errorType: RpcErrorType,
    operation?: RpcOperationType
  ): void;
};

/**
 * Callback for failover state changes - allows UI to react to failover events
 */
export type FailoverStateChangeCallback = (
  chainName: string,
  isUsingFallback: boolean,
  reason: "failover" | "recovery"
) => void;

/**
 * No-op metrics collector for environments without metrics (e.g., frontend)
 */
export const noopMetricsCollector: RpcMetricsCollector = {
  recordPrimaryAttempt: (_chain: string, _operation?: RpcOperationType) => {
    /* noop */
  },
  recordPrimaryFailure: (_chain: string, _operation?: RpcOperationType) => {
    /* noop */
  },
  recordFallbackAttempt: (_chain: string, _operation?: RpcOperationType) => {
    /* noop */
  },
  recordFallbackFailure: (_chain: string, _operation?: RpcOperationType) => {
    /* noop */
  },
  recordFailoverEvent: () => {
    /* noop */
  },
  recordRecoveryEvent: () => {
    /* noop */
  },
  recordBothFailed: () => {
    /* noop */
  },
  recordSuccess: (
    _chain: string,
    _provider: RpcRoutePosition,
    _operation?: RpcOperationType
  ) => {
    /* noop */
  },
  recordLatency: (
    _chain: string,
    _provider: RpcRoutePosition,
    _durationMs: number,
    _operation?: RpcOperationType
  ) => {
    /* noop */
  },
  recordErrorType: (
    _chain: string,
    _provider: RpcRoutePosition,
    _errorType: RpcErrorType,
    _operation?: RpcOperationType
  ) => {
    /* noop */
  },
};

/**
 * Console-based metrics collector for debugging
 */
export const consoleMetricsCollector: RpcMetricsCollector = {
  recordPrimaryAttempt: (chain, operation = RpcOperationType.READ) =>
    console.debug(`[RPC Metrics] Primary attempt: ${chain} [${operation}]`),
  recordPrimaryFailure: (chain, operation = RpcOperationType.READ) =>
    console.debug(`[RPC Metrics] Primary failure: ${chain} [${operation}]`),
  recordFallbackAttempt: (chain, operation = RpcOperationType.READ) =>
    console.debug(`[RPC Metrics] Fallback attempt: ${chain} [${operation}]`),
  recordFallbackFailure: (chain, operation = RpcOperationType.READ) =>
    console.debug(`[RPC Metrics] Fallback failure: ${chain} [${operation}]`),
  recordFailoverEvent: (chain) =>
    console.debug(`[RPC Metrics] Failover event: ${chain}`),
  recordRecoveryEvent: (chain) =>
    console.debug(`[RPC Metrics] Recovery event: ${chain}`),
  recordBothFailed: (chain) =>
    console.debug(`[RPC Metrics] Both endpoints failed: ${chain}`),
  recordSuccess: (chain, provider, operation = RpcOperationType.READ) =>
    console.debug(
      `[RPC Metrics] Success on ${provider}: ${chain} [${operation}]`
    ),
  recordLatency: (
    chain,
    provider,
    durationMs,
    operation = RpcOperationType.READ
  ) =>
    console.debug(
      `[RPC Metrics] Latency ${provider} ${chain}: ${durationMs}ms [${operation}]`
    ),
  recordErrorType: (
    chain,
    provider,
    errorType,
    operation = RpcOperationType.READ
  ) =>
    console.debug(
      `[RPC Metrics] Error ${errorType} on ${provider}: ${chain} [${operation}]`
    ),
};

/**
 * Classify an RPC error into a category for metrics tracking.
 * Standalone version for use outside of executeWithFailover
 * (e.g., write transaction send paths).
 */
export function classifyRpcError(error: unknown): RpcErrorType {
  if (error instanceof Error && error.message.startsWith("Timeout after ")) {
    return RpcErrorType.TIMEOUT;
  }
  if (isError(error, "SERVER_ERROR")) {
    const serverErr = error as ethers.EthersError & {
      response?: { statusCode?: number };
    };
    if (serverErr.response?.statusCode === 429) {
      return RpcErrorType.RATE_LIMIT;
    }
  }
  if (
    error instanceof Error &&
    RPC_CONNECTION_ERROR_PATTERNS.some((pattern) =>
      error.message.includes(pattern)
    )
  ) {
    return RpcErrorType.CONNECTION;
  }
  return RpcErrorType.RPC_ERROR;
}

function isConnectionRefusal(error: unknown): boolean {
  const message =
    error instanceof Error
      ? error.message.toLowerCase()
      : String(error).toLowerCase();
  return (
    message.includes("econnrefused") || message.includes("connection refused")
  );
}

export type RpcProviderConfig = {
  primaryRpcUrl: string;
  fallbackRpcUrl?: string;
  maxRetries?: number;
  timeoutMs?: number;
  chainName?: string;
  chainId?: number;
  // True only when the private-mempool swap put the chain's relay on the
  // primary. Defaults to false, so a manager built from raw URLs keeps
  // attributing its failures to KeeperHub.
  primaryIsPrivateRelay?: boolean;
  /**
   * Who runs the endpoints. An exhausted round on a route that includes an
   * organization endpoint raises OrgRpcError, which platform logging drops.
   */
  failureOwner?: RpcOrigin;
};

export type RpcProviderMetrics = {
  primaryAttempts: number;
  primaryFailures: number;
  fallbackAttempts: number;
  fallbackFailures: number;
  totalRequests: number;
  lastFailoverTime: Date | null;
};

export type RpcProviderManagerOptions = {
  config: RpcProviderConfig;
  metricsCollector?: RpcMetricsCollector;
  /**
   * Where this manager's counters and lifecycle logs go. Defaults to the
   * KeeperHub sink over `metricsCollector`; the RPC engine passes a route
   * sink so organization endpoints never reach platform telemetry.
   */
  telemetry?: RpcTelemetrySink;
  onFailoverStateChange?: FailoverStateChangeCallback;
};

export class RpcProviderManager {
  private primaryProvider: ethers.JsonRpcProvider | null = null;
  private fallbackProvider: ethers.JsonRpcProvider | null = null;
  private readonly config: Required<
    Omit<RpcProviderConfig, "fallbackRpcUrl">
  > & {
    fallbackRpcUrl?: string;
  };
  private readonly metrics: RpcProviderMetrics;
  private readonly telemetry: RpcTelemetrySink;
  private isUsingFallback = false;
  private onFailoverStateChange?: FailoverStateChangeCallback;

  private static readonly DEFAULT_MAX_RETRIES = 3;
  private static readonly DEFAULT_TIMEOUT_MS = 30_000;
  private static readonly RETRY_AFTER_CAP_SECONDS = 30;

  constructor(options: RpcProviderManagerOptions) {
    const {
      config,
      metricsCollector = noopMetricsCollector,
      telemetry,
      onFailoverStateChange,
    } = options;
    this.onFailoverStateChange = onFailoverStateChange;

    this.config = {
      primaryRpcUrl: config.primaryRpcUrl,
      fallbackRpcUrl: config.fallbackRpcUrl,
      maxRetries: config.maxRetries ?? RpcProviderManager.DEFAULT_MAX_RETRIES,
      timeoutMs: config.timeoutMs ?? RpcProviderManager.DEFAULT_TIMEOUT_MS,
      chainName: config.chainName ?? "unknown",
      chainId: config.chainId ?? 1,
      primaryIsPrivateRelay: config.primaryIsPrivateRelay ?? false,
      failureOwner: config.failureOwner ?? RpcOrigin.PLATFORM,
    };

    this.telemetry =
      telemetry ??
      createPlatformSink({
        family: RpcChainType.EVM,
        chainName: this.config.chainName,
        collector: metricsCollector,
      });

    this.metrics = {
      primaryAttempts: 0,
      primaryFailures: 0,
      fallbackAttempts: 0,
      fallbackFailures: 0,
      totalRequests: 0,
      lastFailoverTime: null,
    };
  }

  private createProvider(url: string): ethers.JsonRpcProvider {
    const fetchRequest = new ethers.FetchRequest(url);
    fetchRequest.timeout = 5000;
    fetchRequest.getUrlFunc = safeEthersGetUrl;

    const provider = new ethers.JsonRpcProvider(
      fetchRequest,
      ethers.Network.from(this.config.chainId),
      {
        cacheTimeout: -1,
        staticNetwork: true,
        // Disable JSON-RPC batching: ethers v6 batches concurrent calls into one
        // HTTP request by default. When the RPC proxy returns an incomplete batch
        // response, ethers throws BAD_DATA "missing response for request". Sending
        // each call as its own HTTP request eliminates this class of errors. No
        // performance impact -- workflow execution is sequential, and batch-reads
        // use Multicall3 at the contract level.
        batchMaxCount: 1,
      }
    );

    return provider;
  }

  private getPrimaryProvider(): ethers.JsonRpcProvider {
    if (!this.primaryProvider) {
      this.primaryProvider = this.createProvider(this.config.primaryRpcUrl);
    }
    return this.primaryProvider;
  }

  getFallbackProvider(): ethers.JsonRpcProvider | null {
    if (!this.fallbackProvider && this.config.fallbackRpcUrl) {
      this.fallbackProvider = this.createProvider(this.config.fallbackRpcUrl);
    }
    return this.fallbackProvider;
  }

  getProvider(): ethers.JsonRpcProvider {
    if (this.isUsingFallback && this.fallbackProvider) {
      return this.fallbackProvider;
    }
    return this.getPrimaryProvider();
  }

  async executeWithFailover<T>(
    operation: (provider: ethers.JsonRpcProvider) => Promise<T>,
    operationType: RpcOperationType = RpcOperationType.READ
  ): Promise<T> {
    this.metrics.totalRequests += 1;

    // When in sticky fallback state, try fallback first, then primary as recovery
    if (this.isUsingFallback) {
      const fallbackProvider = this.getFallbackProvider();
      if (fallbackProvider) {
        const fallbackResult = await this.tryProvider(
          fallbackProvider,
          operation,
          RpcRoutePosition.FALLBACK,
          this.config.maxRetries,
          operationType
        );

        if (fallbackResult.success) {
          this.telemetry.success(RpcRoutePosition.FALLBACK, operationType);
          return fallbackResult.result as T;
        }

        // Fallback failed - try primary in case it recovered. Not an outage
        // yet, so a Sentry warning with no error metric and no page.
        this.telemetry.event({
          type: RpcTelemetryEventType.FALLBACK_FAILED,
          error: fallbackResult.error ?? "Unknown error",
        });

        const primaryProvider = this.getPrimaryProvider();
        const primaryResult = await this.tryProvider(
          primaryProvider,
          operation,
          RpcRoutePosition.PRIMARY,
          this.config.maxRetries,
          operationType
        );

        if (primaryResult.success) {
          this.telemetry.event({ type: RpcTelemetryEventType.RECOVERED });
          this.isUsingFallback = false;
          this.telemetry.recovery();
          this.onFailoverStateChange?.(
            this.config.chainName,
            false,
            "recovery"
          );
          return primaryResult.result as T;
        }

        // Both failed -- throw without redundant retry. On KeeperHub
        // endpoints the sink reports this as a platform fault.
        this.telemetry.bothFailed();
        this.telemetry.event({
          type: RpcTelemetryEventType.BOTH_FAILED,
          detail: `Fallback: ${fallbackResult.error}. Primary: ${primaryResult.error}`,
        });
        // Thrown messages reach end users via step errors; drop provider
        // URLs entirely (host included). Internal logs above keep the
        // host-visible masked form.
        throw this.failoverError(
          `RPC failed on both endpoints. Fallback: ${fallbackResult.error}. Primary: ${primaryResult.error}`,
          [
            {
              endpoint: RpcRoutePosition.FALLBACK,
              transport: fallbackResult.transport,
              allAttemptsConnectionRefused:
                fallbackResult.allAttemptsConnectionRefused,
            },
            {
              endpoint: RpcRoutePosition.PRIMARY,
              transport: primaryResult.transport,
              allAttemptsConnectionRefused:
                primaryResult.allAttemptsConnectionRefused,
            },
          ]
        );
      }
    }

    // Normal path: try primary first, then fallback
    const primaryProvider = this.getPrimaryProvider();
    const primaryResult = await this.tryProvider(
      primaryProvider,
      operation,
      RpcRoutePosition.PRIMARY,
      this.config.maxRetries,
      operationType
    );

    if (primaryResult.success) {
      this.telemetry.success(RpcRoutePosition.PRIMARY, operationType);
      return primaryResult.result as T;
    }

    const fallbackProvider = this.getFallbackProvider();
    if (fallbackProvider) {
      this.metrics.lastFailoverTime = new Date();
      this.telemetry.failover();

      const fallbackResult = await this.tryProvider(
        fallbackProvider,
        operation,
        RpcRoutePosition.FALLBACK,
        this.config.maxRetries,
        operationType
      );

      if (fallbackResult.success) {
        // The call was served, so this is a recovery event rather than an
        // outage: Sentry warning, no error metric, no page.
        this.telemetry.event({
          type: RpcTelemetryEventType.FAILOVER_ACTIVATED,
          error: primaryResult.error ?? "Unknown error",
        });
        this.isUsingFallback = true;
        this.onFailoverStateChange?.(this.config.chainName, true, "failover");
        return fallbackResult.result as T;
      }

      this.telemetry.bothFailed();
      this.telemetry.event({
        type: RpcTelemetryEventType.BOTH_FAILED,
        detail: `Primary: ${primaryResult.error}. Fallback: ${fallbackResult.error}`,
      });
      throw this.failoverError(
        `RPC failed on both endpoints. Primary: ${primaryResult.error}. Fallback: ${fallbackResult.error}`,
        [
          {
            endpoint: RpcRoutePosition.PRIMARY,
            transport: primaryResult.transport,
            allAttemptsConnectionRefused:
              primaryResult.allAttemptsConnectionRefused,
          },
          {
            endpoint: RpcRoutePosition.FALLBACK,
            transport: fallbackResult.transport,
            allAttemptsConnectionRefused:
              fallbackResult.allAttemptsConnectionRefused,
          },
        ]
      );
    }

    throw this.failoverError(
      `RPC failed on primary endpoint: ${primaryResult.error}`,
      [
        {
          endpoint: RpcRoutePosition.PRIMARY,
          transport: primaryResult.transport,
          allAttemptsConnectionRefused:
            primaryResult.allAttemptsConnectionRefused,
        },
      ]
    );
  }

  /**
   * Build the error for an exhausted failover round.
   *
   * Becomes a relay error only when the round never touched an endpoint we
   * operate AND every attempt failed on transport. In practice that is the
   * strict private-mempool case, where the swap left the relay as the only
   * endpoint. Anything else stays a plain Error so the message classifier
   * keeps deciding, which for RPC means a platform fault.
   */
  private failoverError(
    message: string,
    failures: readonly {
      endpoint: RpcRoutePosition;
      transport?: boolean;
      allAttemptsConnectionRefused?: boolean;
    }[]
  ): Error {
    const redacted = redactAllUrls(message);
    const allAttemptsConnectionRefused =
      failures.length > 0 &&
      failures.every(
        (failure) => failure.allAttemptsConnectionRefused === true
      );
    const allOnTheRelay = failures.every(
      (failure) =>
        failure.transport &&
        failure.endpoint === RpcRoutePosition.PRIMARY &&
        this.config.primaryIsPrivateRelay
    );
    let result: Error;
    if (this.config.failureOwner === RpcOrigin.ORG) {
      result = new OrgRpcError(redacted);
    } else if (allOnTheRelay) {
      result = new RpcRelayTransportError(redacted);
    } else {
      result = new Error(redacted);
    }
    // A write-broadcast classifier must know whether *every retry attempt*
    // was refused. The rendered message only contains each endpoint's final
    // error, so text alone can turn "timeout, then refused" into "never sent".
    // Duck-typed by submit-signed.ts to avoid coupling callers to this class.
    Object.assign(result, { allAttemptsConnectionRefused });
    return result;
  }

  private recordAttempt(
    providerType: RpcRoutePosition,
    operationType: RpcOperationType = RpcOperationType.READ
  ): void {
    if (providerType === RpcRoutePosition.PRIMARY) {
      this.metrics.primaryAttempts += 1;
    } else {
      this.metrics.fallbackAttempts += 1;
    }
    this.telemetry.attempt(providerType, operationType);
  }

  private recordFailure(
    providerType: RpcRoutePosition,
    operationType: RpcOperationType = RpcOperationType.READ
  ): void {
    if (providerType === RpcRoutePosition.PRIMARY) {
      this.metrics.primaryFailures += 1;
    } else {
      this.metrics.fallbackFailures += 1;
    }
    this.telemetry.failure(providerType, operationType);
  }

  /**
   * Compute how long to wait before retrying, or return null to stop retrying.
   * Handles 429 Retry-After headers and exponential backoff for other errors.
   */
  private getRetryDelayMs(error: unknown, attempt: number): number | null {
    if (isError(error, "SERVER_ERROR") && error.response?.statusCode === 429) {
      const retryAfterHeader = error.response.getHeader("retry-after");
      const retryAfterSeconds = retryAfterHeader
        ? Number.parseInt(retryAfterHeader, 10)
        : Number.NaN;

      if (
        !Number.isNaN(retryAfterSeconds) &&
        retryAfterSeconds > 0 &&
        retryAfterSeconds <= RpcProviderManager.RETRY_AFTER_CAP_SECONDS
      ) {
        return retryAfterSeconds * 1000;
      }

      return null;
    }

    return Math.min(1000 * 2 ** attempt, 5000);
  }

  /**
   * Evaluate a caught error and decide what to do next.
   * Throws for non-retryable errors, returns null to stop retrying,
   * or returns the delay in ms before the next attempt.
   */
  private evaluateRetryAction(
    error: unknown,
    wrappedError: Error,
    attempt: number,
    maxRetries: number
  ): number | null {
    if (isNonRetryableError(error)) {
      throw wrappedError;
    }

    if (attempt === maxRetries - 1) {
      return null;
    }

    return this.getRetryDelayMs(error, attempt);
  }

  private classifyError(error: unknown): RpcErrorType {
    return classifyRpcError(error);
  }

  private async tryProvider<T>(
    provider: ethers.JsonRpcProvider,
    operation: (p: ethers.JsonRpcProvider) => Promise<T>,
    providerType: RpcRoutePosition,
    maxRetries: number,
    operationType: RpcOperationType = RpcOperationType.READ
  ): Promise<{
    success: boolean;
    result?: T;
    error?: string;
    /** Whether the last attempt failed on transport rather than on an answer. */
    transport?: boolean;
    /** True only when every retry attempt ended in a connection refusal. */
    allAttemptsConnectionRefused?: boolean;
  }> {
    let lastError: Error | undefined;
    let attemptCount = 0;
    let allAttemptsConnectionRefused = true;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const startTime = performance.now();
      try {
        this.recordAttempt(providerType, operationType);

        const result = await this.withTimeout(
          operation(provider),
          this.config.timeoutMs
        );

        const durationMs = performance.now() - startTime;
        this.telemetry.latency(providerType, durationMs, operationType);

        return { success: true, result };
      } catch (error: unknown) {
        const durationMs = performance.now() - startTime;
        this.telemetry.latency(providerType, durationMs, operationType);

        lastError = error instanceof Error ? error : new Error(String(error));
        attemptCount += 1;
        allAttemptsConnectionRefused =
          allAttemptsConnectionRefused && isConnectionRefusal(error);
        this.recordFailure(providerType, operationType);
        this.telemetry.errorType(
          providerType,
          this.classifyError(error),
          operationType
        );

        const delayMs = this.evaluateRetryAction(
          error,
          lastError,
          attempt,
          maxRetries
        );
        if (delayMs === null) {
          break;
        }

        await sleep(delayMs);
      }
    }

    return {
      success: false,
      // Ethers v6 inlines info.requestUrl (keyed RPC URL) into Error.message;
      // mask the key before the message reaches thrown errors and logs.
      error: scrubRpcUrls(lastError?.message ?? "") || "Unknown error",
      transport: isTransportFailure(lastError),
      allAttemptsConnectionRefused:
        attemptCount > 0 && allAttemptsConnectionRefused,
    };
  }

  private withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    return Promise.race([
      promise,
      new Promise<T>((_, reject) =>
        setTimeout(
          () => reject(new Error(`Timeout after ${timeoutMs}ms`)),
          timeoutMs
        )
      ),
    ]);
  }

  getMetrics(): Readonly<RpcProviderMetrics> {
    return { ...this.metrics };
  }

  isCurrentlyUsingFallback(): boolean {
    return this.isUsingFallback;
  }

  getCurrentProviderType(): RpcRoutePosition {
    return this.isUsingFallback
      ? RpcRoutePosition.FALLBACK
      : RpcRoutePosition.PRIMARY;
  }

  /**
   * Register a callback for failover state changes.
   * Useful for updating UI when failover occurs.
   */
  setFailoverStateChangeCallback(callback: FailoverStateChangeCallback): void {
    this.onFailoverStateChange = callback;
  }

  /**
   * Get the currently-active RPC URL, respecting cached failover state.
   * Does NOT probe the endpoint -- use resolveActiveRpcUrl() for write
   * operations where you need to verify the endpoint is reachable first.
   */
  getCurrentRpcUrl(): string {
    return this.isUsingFallback && this.config.fallbackRpcUrl
      ? this.config.fallbackRpcUrl
      : this.config.primaryRpcUrl;
  }

  /**
   * Probe the RPC endpoint with a lightweight getBlockNumber call via
   * executeWithFailover, then return the URL of whichever provider responded.
   * Use this for write operations that need a raw URL for signer construction
   * but should still benefit from failover if the primary is unreachable.
   */
  async resolveActiveRpcUrl(): Promise<string> {
    await this.executeWithFailover((provider) => provider.getBlockNumber());
    return this.getCurrentRpcUrl();
  }

  /**
   * Get the chain name this manager is configured for
   */
  getChainName(): string {
    return this.config.chainName;
  }

  /**
   * A collector view over this manager's telemetry sink, for code that
   * records around the manager by hand; it obeys the same routing.
   */
  getMetricsCollector(): RpcMetricsCollector {
    return collectorFromSink(this.telemetry);
  }

  /** Report that this manager was created and cached. */
  reportCreated(): void {
    this.telemetry.event({
      type: RpcTelemetryEventType.CREATED,
      hasFallback: Boolean(this.config.fallbackRpcUrl),
    });
  }
}

// Managers are cached per route to keep failover state across requests. The
// engine adds one per organization route, so the cache is bounded; a dropped
// manager holds no timers and is freed once no call still uses it.
const MANAGER_CACHE_LIMIT = 1000;
const managerCache = new BoundedCache<RpcProviderManager>(MANAGER_CACHE_LIMIT);

export type CreateRpcProviderManagerOptions = {
  primaryRpcUrl: string;
  fallbackRpcUrl?: string;
  maxRetries?: number;
  timeoutMs?: number;
  chainName?: string;
  chainId?: number;
  primaryIsPrivateRelay?: boolean;
  failureOwner?: RpcOrigin;
  metricsCollector?: RpcMetricsCollector;
  telemetry?: RpcTelemetrySink;
  onFailoverStateChange?: FailoverStateChangeCallback;
  /**
   * Overrides the URL-based cache key. The RPC engine passes its route key so
   * two routes over the same URLs but with different attribution never
   * share a manager (and its telemetry sink).
   */
  cacheKey?: string;
};

export function createRpcProviderManager(
  options: CreateRpcProviderManagerOptions
): RpcProviderManager {
  const cacheKey =
    options.cacheKey ??
    `${options.primaryRpcUrl}|${options.fallbackRpcUrl || ""}|${options.chainId ?? ""}`;

  let manager = managerCache.get(cacheKey);
  if (!manager) {
    manager = new RpcProviderManager({
      config: {
        primaryRpcUrl: options.primaryRpcUrl,
        fallbackRpcUrl: options.fallbackRpcUrl,
        maxRetries: options.maxRetries,
        timeoutMs: options.timeoutMs,
        chainName: options.chainName,
        chainId: options.chainId,
        primaryIsPrivateRelay: options.primaryIsPrivateRelay,
        failureOwner: options.failureOwner,
      },
      metricsCollector: options.metricsCollector,
      telemetry: options.telemetry,
      onFailoverStateChange: options.onFailoverStateChange,
    });
    managerCache.set(cacheKey, manager);
    manager.reportCreated();
  } else if (options.onFailoverStateChange) {
    // Update callback on existing manager if provided
    manager.setFailoverStateChangeCallback(options.onFailoverStateChange);
  }

  return manager;
}

/**
 * Get the current failover state for all cached managers
 */
export function getAllFailoverStates(): Map<
  string,
  { chainName: string; isUsingFallback: boolean }
> {
  const states = new Map<
    string,
    { chainName: string; isUsingFallback: boolean }
  >();
  managerCache.forEach((manager, key) => {
    states.set(key, {
      chainName: manager.getChainName(),
      isUsingFallback: manager.isCurrentlyUsingFallback(),
    });
  });
  return states;
}

export function clearRpcProviderManagerCache(): void {
  managerCache.clear();
}
