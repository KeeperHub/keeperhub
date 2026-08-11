import { ethers, isError } from "ethers";
import { ErrorCategory, logUserError } from "@/lib/logging";
import { safeEthersGetUrl } from "../safe-ethers-fetch";
import { redactAllUrls, scrubRpcUrls } from "../scrub-rpc-urls";
import {
  isNonRetryableError,
  isTransportFailure,
  RPC_CONNECTION_ERROR_PATTERNS,
} from "./error-classification";
import { RpcRelayTransportError } from "./transport-error";

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
export type RpcErrorType =
  | "timeout"
  | "rate_limit"
  | "connection"
  | "rpc_error";

export type RpcOperationType =
  | "read"
  | "write"
  | "preflight"
  | "write-broadcast";

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
    provider: "primary" | "fallback",
    operation?: RpcOperationType
  ): void;
  recordLatency(
    chainName: string,
    provider: "primary" | "fallback",
    durationMs: number,
    operation?: RpcOperationType
  ): void;
  recordErrorType(
    chainName: string,
    provider: "primary" | "fallback",
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
    _provider: "primary" | "fallback",
    _operation?: RpcOperationType
  ) => {
    /* noop */
  },
  recordLatency: (
    _chain: string,
    _provider: "primary" | "fallback",
    _durationMs: number,
    _operation?: RpcOperationType
  ) => {
    /* noop */
  },
  recordErrorType: (
    _chain: string,
    _provider: "primary" | "fallback",
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
  recordPrimaryAttempt: (chain, operation = "read") =>
    console.debug(`[RPC Metrics] Primary attempt: ${chain} [${operation}]`),
  recordPrimaryFailure: (chain, operation = "read") =>
    console.debug(`[RPC Metrics] Primary failure: ${chain} [${operation}]`),
  recordFallbackAttempt: (chain, operation = "read") =>
    console.debug(`[RPC Metrics] Fallback attempt: ${chain} [${operation}]`),
  recordFallbackFailure: (chain, operation = "read") =>
    console.debug(`[RPC Metrics] Fallback failure: ${chain} [${operation}]`),
  recordFailoverEvent: (chain) =>
    console.debug(`[RPC Metrics] Failover event: ${chain}`),
  recordRecoveryEvent: (chain) =>
    console.debug(`[RPC Metrics] Recovery event: ${chain}`),
  recordBothFailed: (chain) =>
    console.debug(`[RPC Metrics] Both endpoints failed: ${chain}`),
  recordSuccess: (chain, provider, operation = "read") =>
    console.debug(
      `[RPC Metrics] Success on ${provider}: ${chain} [${operation}]`
    ),
  recordLatency: (chain, provider, durationMs, operation = "read") =>
    console.debug(
      `[RPC Metrics] Latency ${provider} ${chain}: ${durationMs}ms [${operation}]`
    ),
  recordErrorType: (chain, provider, errorType, operation = "read") =>
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
    return "timeout";
  }
  if (isError(error, "SERVER_ERROR")) {
    const serverErr = error as ethers.EthersError & {
      response?: { statusCode?: number };
    };
    if (serverErr.response?.statusCode === 429) {
      return "rate_limit";
    }
  }
  if (
    error instanceof Error &&
    RPC_CONNECTION_ERROR_PATTERNS.some((pattern) =>
      error.message.includes(pattern)
    )
  ) {
    return "connection";
  }
  return "rpc_error";
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
  private readonly metricsCollector: RpcMetricsCollector;
  private isUsingFallback = false;
  private onFailoverStateChange?: FailoverStateChangeCallback;

  private static readonly DEFAULT_MAX_RETRIES = 3;
  private static readonly DEFAULT_TIMEOUT_MS = 30_000;
  private static readonly RETRY_AFTER_CAP_SECONDS = 30;

  constructor(options: RpcProviderManagerOptions) {
    const {
      config,
      metricsCollector = noopMetricsCollector,
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
    };

    this.metricsCollector = metricsCollector;

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
    operationType: RpcOperationType = "read"
  ): Promise<T> {
    this.metrics.totalRequests += 1;

    // When in sticky fallback state, try fallback first, then primary as recovery
    if (this.isUsingFallback) {
      const fallbackProvider = this.getFallbackProvider();
      if (fallbackProvider) {
        const fallbackResult = await this.tryProvider(
          fallbackProvider,
          operation,
          "fallback",
          this.config.maxRetries,
          operationType
        );

        if (fallbackResult.success) {
          this.metricsCollector.recordSuccess(
            this.config.chainName,
            "fallback",
            operationType
          );
          return fallbackResult.result as T;
        }

        // Fallback failed - try primary in case it recovered
        logUserError(
          ErrorCategory.NETWORK_RPC,
          `[RPC] Fallback RPC failed for ${this.config.chainName}, attempting primary recovery`,
          fallbackResult.error,
          {
            event: "RPC_FALLBACK_FAILED",
            chain: this.config.chainName,
          }
        );

        const primaryProvider = this.getPrimaryProvider();
        const primaryResult = await this.tryProvider(
          primaryProvider,
          operation,
          "primary",
          this.config.maxRetries,
          operationType
        );

        if (primaryResult.success) {
          console.info(
            JSON.stringify({
              level: "info",
              event: "RPC_FAILOVER_RECOVERY",
              message: `Primary RPC recovered for ${this.config.chainName}, switching back from fallback`,
              chain: this.config.chainName,
              previousState: "fallback",
              newState: "primary",
              timestamp: new Date().toISOString(),
            })
          );
          this.isUsingFallback = false;
          this.metricsCollector.recordRecoveryEvent(this.config.chainName);
          this.onFailoverStateChange?.(
            this.config.chainName,
            false,
            "recovery"
          );
          return primaryResult.result as T;
        }

        // Both failed -- throw without redundant retry
        this.metricsCollector.recordBothFailed(this.config.chainName);
        logUserError(
          ErrorCategory.NETWORK_RPC,
          `[RPC] Both primary and fallback RPC failed for ${this.config.chainName}`,
          `Fallback: ${fallbackResult.error}. Primary: ${primaryResult.error}`,
          {
            event: "RPC_BOTH_ENDPOINTS_FAILED",
            chain: this.config.chainName,
          }
        );
        // Thrown messages reach end users via step errors; drop provider
        // URLs entirely (host included). Internal logs above keep the
        // host-visible masked form.
        throw this.failoverError(
          `RPC failed on both endpoints. Fallback: ${fallbackResult.error}. Primary: ${primaryResult.error}`,
          [
            { endpoint: "fallback", transport: fallbackResult.transport },
            { endpoint: "primary", transport: primaryResult.transport },
          ]
        );
      }
    }

    // Normal path: try primary first, then fallback
    const primaryProvider = this.getPrimaryProvider();
    const primaryResult = await this.tryProvider(
      primaryProvider,
      operation,
      "primary",
      this.config.maxRetries,
      operationType
    );

    if (primaryResult.success) {
      this.metricsCollector.recordSuccess(
        this.config.chainName,
        "primary",
        operationType
      );
      return primaryResult.result as T;
    }

    const fallbackProvider = this.getFallbackProvider();
    if (fallbackProvider) {
      this.metrics.lastFailoverTime = new Date();
      this.metricsCollector.recordFailoverEvent(this.config.chainName);

      const fallbackResult = await this.tryProvider(
        fallbackProvider,
        operation,
        "fallback",
        this.config.maxRetries,
        operationType
      );

      if (fallbackResult.success) {
        logUserError(
          ErrorCategory.NETWORK_RPC,
          `[RPC] Primary RPC failed for ${this.config.chainName}, switching to fallback`,
          primaryResult.error,
          {
            event: "RPC_FAILOVER_ACTIVATED",
            chain: this.config.chainName,
            previous_state: "primary",
            new_state: "fallback",
          }
        );
        this.isUsingFallback = true;
        this.onFailoverStateChange?.(this.config.chainName, true, "failover");
        return fallbackResult.result as T;
      }

      this.metricsCollector.recordBothFailed(this.config.chainName);
      logUserError(
        ErrorCategory.NETWORK_RPC,
        `[RPC] Both primary and fallback RPC failed for ${this.config.chainName}`,
        `Primary: ${primaryResult.error}. Fallback: ${fallbackResult.error}`,
        {
          event: "RPC_BOTH_ENDPOINTS_FAILED",
          chain: this.config.chainName,
        }
      );
      throw this.failoverError(
        `RPC failed on both endpoints. Primary: ${primaryResult.error}. Fallback: ${fallbackResult.error}`,
        [
          { endpoint: "primary", transport: primaryResult.transport },
          { endpoint: "fallback", transport: fallbackResult.transport },
        ]
      );
    }

    throw this.failoverError(
      `RPC failed on primary endpoint: ${primaryResult.error}`,
      [{ endpoint: "primary", transport: primaryResult.transport }]
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
      endpoint: "primary" | "fallback";
      transport?: boolean;
    }[]
  ): Error {
    const redacted = redactAllUrls(message);
    const allOnTheRelay = failures.every(
      (failure) =>
        failure.transport &&
        failure.endpoint === "primary" &&
        this.config.primaryIsPrivateRelay
    );
    return allOnTheRelay
      ? new RpcRelayTransportError(redacted)
      : new Error(redacted);
  }

  private recordAttempt(
    providerType: "primary" | "fallback",
    operationType: RpcOperationType = "read"
  ): void {
    if (providerType === "primary") {
      this.metrics.primaryAttempts += 1;
      this.metricsCollector.recordPrimaryAttempt(
        this.config.chainName,
        operationType
      );
    } else {
      this.metrics.fallbackAttempts += 1;
      this.metricsCollector.recordFallbackAttempt(
        this.config.chainName,
        operationType
      );
    }
  }

  private recordFailure(
    providerType: "primary" | "fallback",
    operationType: RpcOperationType = "read"
  ): void {
    if (providerType === "primary") {
      this.metrics.primaryFailures += 1;
      this.metricsCollector.recordPrimaryFailure(
        this.config.chainName,
        operationType
      );
    } else {
      this.metrics.fallbackFailures += 1;
      this.metricsCollector.recordFallbackFailure(
        this.config.chainName,
        operationType
      );
    }
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
    providerType: "primary" | "fallback",
    maxRetries: number,
    operationType: RpcOperationType = "read"
  ): Promise<{
    success: boolean;
    result?: T;
    error?: string;
    /** Whether the last attempt failed on transport rather than on an answer. */
    transport?: boolean;
  }> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const startTime = performance.now();
      try {
        this.recordAttempt(providerType, operationType);

        const result = await this.withTimeout(
          operation(provider),
          this.config.timeoutMs
        );

        const durationMs = performance.now() - startTime;
        this.metricsCollector.recordLatency(
          this.config.chainName,
          providerType,
          durationMs,
          operationType
        );

        return { success: true, result };
      } catch (error: unknown) {
        const durationMs = performance.now() - startTime;
        this.metricsCollector.recordLatency(
          this.config.chainName,
          providerType,
          durationMs,
          operationType
        );

        lastError = error instanceof Error ? error : new Error(String(error));
        this.recordFailure(providerType, operationType);
        this.metricsCollector.recordErrorType(
          this.config.chainName,
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

        await this.delay(delayMs);
      }
    }

    return {
      success: false,
      // Ethers v6 inlines info.requestUrl (keyed RPC URL) into Error.message;
      // mask the key before the message reaches thrown errors and logs.
      error: scrubRpcUrls(lastError?.message ?? "") || "Unknown error",
      transport: isTransportFailure(lastError),
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

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  getMetrics(): Readonly<RpcProviderMetrics> {
    return { ...this.metrics };
  }

  isCurrentlyUsingFallback(): boolean {
    return this.isUsingFallback;
  }

  getCurrentProviderType(): "primary" | "fallback" {
    return this.isUsingFallback ? "fallback" : "primary";
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

  getMetricsCollector(): RpcMetricsCollector {
    return this.metricsCollector;
  }
}

// Cache managers by RPC URL combination to persist failover state across requests
const managerCache = new Map<string, RpcProviderManager>();

export type CreateRpcProviderManagerOptions = {
  primaryRpcUrl: string;
  fallbackRpcUrl?: string;
  maxRetries?: number;
  timeoutMs?: number;
  chainName?: string;
  chainId?: number;
  primaryIsPrivateRelay?: boolean;
  metricsCollector?: RpcMetricsCollector;
  onFailoverStateChange?: FailoverStateChangeCallback;
};

export function createRpcProviderManager(
  options: CreateRpcProviderManagerOptions
): RpcProviderManager {
  const cacheKey = `${options.primaryRpcUrl}|${options.fallbackRpcUrl || ""}|${options.chainId ?? ""}`;

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
      },
      metricsCollector: options.metricsCollector,
      onFailoverStateChange: options.onFailoverStateChange,
    });
    managerCache.set(cacheKey, manager);
    console.info(
      JSON.stringify({
        level: "info",
        event: "RPC_PROVIDER_CREATED",
        message: `Created RPC provider manager for ${options.chainName || "unknown"}`,
        chain: options.chainName || "unknown",
        hasFallback: !!options.fallbackRpcUrl,
        timestamp: new Date().toISOString(),
      })
    );
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
