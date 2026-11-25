import { type Commitment, Connection } from "@solana/web3.js";
import { safeFetch } from "@/lib/safe-fetch";
import { sleep } from "@/lib/sleep";
import { createPlatformSink } from "../engine/telemetry/platform-sink";
import {
  RpcErrorType,
  RpcOperationType,
  RpcTelemetryEventType,
  type RpcTelemetrySink,
} from "../engine/telemetry/sink";
import { RpcChainType, RpcRoutePosition } from "../engine/types";
import { redactAllUrls, scrubRpcUrls } from "../scrub-rpc-urls";
import { RPC_CONNECTION_ERROR_PATTERNS } from "./index";

/**
 * Custom fetch passed to `Connection`'s `ConnectionConfig.fetch` so
 * user-supplied Solana RPC URLs go through the SSRF guard. Without this
 * the @solana/web3.js Connection uses Node's global fetch, which bypasses
 * `lib/safe-fetch`'s denylist.
 */
const safeSolanaFetch = (
  info: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1]
): Promise<Response> =>
  safeFetch(info as Parameters<typeof safeFetch>[0], {
    ...init,
    plugin: "rpc-solana",
  });

/**
 * Solana RPC Provider Manager
 *
 * Similar to the EVM RpcProviderManager but uses @solana/web3.js Connection
 * instead of ethers.JsonRpcProvider.
 */

export type SolanaRpcMetricsCollector = {
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

export type SolanaFailoverStateChangeCallback = (
  chainName: string,
  isUsingFallback: boolean,
  reason: "failover" | "recovery"
) => void;

export const noopSolanaMetricsCollector: SolanaRpcMetricsCollector = {
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

export const consoleSolanaMetricsCollector: SolanaRpcMetricsCollector = {
  recordPrimaryAttempt: (chain, operation = RpcOperationType.READ) =>
    console.debug(
      `[Solana RPC Metrics] Primary attempt: ${chain} [${operation}]`
    ),
  recordPrimaryFailure: (chain, operation = RpcOperationType.READ) =>
    console.debug(
      `[Solana RPC Metrics] Primary failure: ${chain} [${operation}]`
    ),
  recordFallbackAttempt: (chain, operation = RpcOperationType.READ) =>
    console.debug(
      `[Solana RPC Metrics] Fallback attempt: ${chain} [${operation}]`
    ),
  recordFallbackFailure: (chain, operation = RpcOperationType.READ) =>
    console.debug(
      `[Solana RPC Metrics] Fallback failure: ${chain} [${operation}]`
    ),
  recordFailoverEvent: (chain) =>
    console.debug(`[Solana RPC Metrics] Failover event: ${chain}`),
  recordRecoveryEvent: (chain) =>
    console.debug(`[Solana RPC Metrics] Recovery event: ${chain}`),
  recordBothFailed: (chain) =>
    console.debug(`[Solana RPC Metrics] Both endpoints failed: ${chain}`),
  recordSuccess: (chain, provider, operation = RpcOperationType.READ) =>
    console.debug(
      `[Solana RPC Metrics] Success on ${provider}: ${chain} [${operation}]`
    ),
  recordLatency: (
    chain,
    provider,
    durationMs,
    operation = RpcOperationType.READ
  ) =>
    console.debug(
      `[Solana RPC Metrics] Latency ${provider} ${chain}: ${durationMs}ms [${operation}]`
    ),
  recordErrorType: (
    chain,
    provider,
    errorType,
    operation = RpcOperationType.READ
  ) =>
    console.debug(
      `[Solana RPC Metrics] Error ${errorType} on ${provider}: ${chain} [${operation}]`
    ),
};

export type SolanaProviderConfig = {
  primaryRpcUrl: string;
  fallbackRpcUrl?: string;
  maxRetries?: number;
  timeoutMs?: number;
  chainName?: string;
  commitment?: Commitment;
};

export type SolanaProviderMetrics = {
  primaryAttempts: number;
  primaryFailures: number;
  fallbackAttempts: number;
  fallbackFailures: number;
  totalRequests: number;
  lastFailoverTime: Date | null;
};

export type SolanaProviderManagerOptions = {
  config: SolanaProviderConfig;
  metricsCollector?: SolanaRpcMetricsCollector;
  /** See RpcProviderManagerOptions.telemetry. */
  telemetry?: RpcTelemetrySink;
  onFailoverStateChange?: SolanaFailoverStateChangeCallback;
};

export class SolanaProviderManager {
  private primaryConnection: Connection | null = null;
  private fallbackConnection: Connection | null = null;
  private readonly config: Required<
    Omit<SolanaProviderConfig, "fallbackRpcUrl">
  > & {
    fallbackRpcUrl?: string;
  };
  private readonly metrics: SolanaProviderMetrics;
  private readonly telemetry: RpcTelemetrySink;
  private isUsingFallback = false;
  private onFailoverStateChange?: SolanaFailoverStateChangeCallback;

  private static readonly DEFAULT_MAX_RETRIES = 3;
  private static readonly DEFAULT_TIMEOUT_MS = 30_000;
  private static readonly DEFAULT_COMMITMENT: Commitment = "confirmed";

  constructor(options: SolanaProviderManagerOptions) {
    const {
      config,
      metricsCollector = noopSolanaMetricsCollector,
      telemetry,
      onFailoverStateChange,
    } = options;
    this.onFailoverStateChange = onFailoverStateChange;

    this.config = {
      primaryRpcUrl: config.primaryRpcUrl,
      fallbackRpcUrl: config.fallbackRpcUrl,
      maxRetries:
        config.maxRetries ?? SolanaProviderManager.DEFAULT_MAX_RETRIES,
      timeoutMs: config.timeoutMs ?? SolanaProviderManager.DEFAULT_TIMEOUT_MS,
      chainName: config.chainName ?? "solana",
      commitment: config.commitment ?? SolanaProviderManager.DEFAULT_COMMITMENT,
    };

    this.telemetry =
      telemetry ??
      createPlatformSink({
        family: RpcChainType.SOLANA,
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

  private createConnection(url: string): Connection {
    return new Connection(url, {
      commitment: this.config.commitment,
      confirmTransactionInitialTimeout: this.config.timeoutMs,
      fetch: safeSolanaFetch,
    });
  }

  private getPrimaryConnection(): Connection {
    if (!this.primaryConnection) {
      this.primaryConnection = this.createConnection(this.config.primaryRpcUrl);
    }
    return this.primaryConnection;
  }

  // Public for the same reason RpcProviderManager.getFallbackProvider is: a
  // read whose "not there" answer is a successful call never triggers
  // failover, so callers that must not trust a single endpoint's silence
  // (lib/web3/verify-receipt.ts) read the fallback explicitly.
  getFallbackConnection(): Connection | null {
    if (!this.fallbackConnection && this.config.fallbackRpcUrl) {
      this.fallbackConnection = this.createConnection(
        this.config.fallbackRpcUrl
      );
    }
    return this.fallbackConnection;
  }

  getConnection(): Connection {
    if (this.isUsingFallback && this.fallbackConnection) {
      return this.fallbackConnection;
    }
    return this.getPrimaryConnection();
  }

  async executeWithFailover<T>(
    operation: (connection: Connection) => Promise<T>,
    operationType: RpcOperationType = RpcOperationType.READ
  ): Promise<T> {
    this.metrics.totalRequests += 1;

    // If we've already switched to fallback, use it directly
    if (this.isUsingFallback) {
      const fallbackConnection = this.getFallbackConnection();
      if (fallbackConnection) {
        const fallbackResult = await this.tryConnection(
          fallbackConnection,
          operation,
          RpcRoutePosition.FALLBACK,
          this.config.maxRetries,
          operationType
        );

        if (fallbackResult.success) {
          this.telemetry.success(RpcRoutePosition.FALLBACK, operationType);
          return fallbackResult.result as T;
        }

        this.telemetry.event({
          type: RpcTelemetryEventType.FALLBACK_FAILED,
          error: fallbackResult.error ?? "Unknown error",
        });
      }
    }

    const primaryConnection = this.getPrimaryConnection();
    const primaryResult = await this.tryConnection(
      primaryConnection,
      operation,
      RpcRoutePosition.PRIMARY,
      this.config.maxRetries,
      operationType
    );

    if (primaryResult.success) {
      this.telemetry.success(RpcRoutePosition.PRIMARY, operationType);
      if (this.isUsingFallback) {
        this.telemetry.event({ type: RpcTelemetryEventType.RECOVERED });
        this.isUsingFallback = false;
        this.telemetry.recovery();
        this.onFailoverStateChange?.(this.config.chainName, false, "recovery");
      }
      return primaryResult.result as T;
    }

    const fallbackConnection = this.getFallbackConnection();
    if (fallbackConnection) {
      this.metrics.lastFailoverTime = new Date();
      this.telemetry.failover();

      const fallbackResult = await this.tryConnection(
        fallbackConnection,
        operation,
        RpcRoutePosition.FALLBACK,
        this.config.maxRetries,
        operationType
      );

      if (fallbackResult.success) {
        this.telemetry.success(RpcRoutePosition.FALLBACK, operationType);
        if (!this.isUsingFallback) {
          this.telemetry.event({
            type: RpcTelemetryEventType.FAILOVER_ACTIVATED,
            error: primaryResult.error ?? "Unknown error",
          });
          this.isUsingFallback = true;
          this.onFailoverStateChange?.(this.config.chainName, true, "failover");
        }
        return fallbackResult.result as T;
      }

      this.telemetry.bothFailed();
      this.telemetry.event({
        type: RpcTelemetryEventType.BOTH_FAILED,
        detail: `Primary: ${primaryResult.error}. Fallback: ${fallbackResult.error}`,
      });
      // Thrown messages reach end users via step errors; drop provider URLs
      // entirely (host included). Internal logs above keep the host-visible
      // masked form.
      throw new Error(
        redactAllUrls(
          `Solana RPC failed on both endpoints. Primary: ${primaryResult.error}. Fallback: ${fallbackResult.error}`
        )
      );
    }

    throw new Error(
      redactAllUrls(
        `Solana RPC failed on primary endpoint: ${primaryResult.error}`
      )
    );
  }

  private classifyError(error: unknown): RpcErrorType {
    if (error instanceof Error && error.message.startsWith("Timeout after ")) {
      return RpcErrorType.TIMEOUT;
    }
    if (
      error instanceof Error &&
      (error.message.includes("429") ||
        error.message.includes("Too Many Requests"))
    ) {
      return RpcErrorType.RATE_LIMIT;
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

  private async tryConnection<T>(
    connection: Connection,
    operation: (c: Connection) => Promise<T>,
    connectionType: RpcRoutePosition,
    maxRetries: number,
    operationType: RpcOperationType = RpcOperationType.READ
  ): Promise<{ success: boolean; result?: T; error?: string }> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const startTime = performance.now();
      try {
        if (connectionType === RpcRoutePosition.PRIMARY) {
          this.metrics.primaryAttempts += 1;
        } else {
          this.metrics.fallbackAttempts += 1;
        }
        this.telemetry.attempt(connectionType, operationType);

        const result = await this.withTimeout(
          operation(connection),
          this.config.timeoutMs
        );

        const durationMs = performance.now() - startTime;
        this.telemetry.latency(connectionType, durationMs, operationType);

        return { success: true, result };
      } catch (error: unknown) {
        const durationMs = performance.now() - startTime;
        this.telemetry.latency(connectionType, durationMs, operationType);

        lastError = error instanceof Error ? error : new Error(String(error));

        if (connectionType === RpcRoutePosition.PRIMARY) {
          this.metrics.primaryFailures += 1;
        } else {
          this.metrics.fallbackFailures += 1;
        }
        this.telemetry.failure(connectionType, operationType);
        this.telemetry.errorType(
          connectionType,
          this.classifyError(error),
          operationType
        );

        if (attempt === maxRetries - 1) {
          break;
        }

        await sleep(Math.min(1000 * 2 ** attempt, 5000));
      }
    }

    return {
      success: false,
      // Mask keyed RPC URLs that providers inline into error messages
      // before the message reaches thrown errors and logs.
      error: scrubRpcUrls(lastError?.message ?? "") || "Unknown error",
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

  getMetrics(): Readonly<SolanaProviderMetrics> {
    return { ...this.metrics };
  }

  isCurrentlyUsingFallback(): boolean {
    return this.isUsingFallback;
  }

  getCurrentConnectionType(): RpcRoutePosition {
    return this.isUsingFallback
      ? RpcRoutePosition.FALLBACK
      : RpcRoutePosition.PRIMARY;
  }

  setFailoverStateChangeCallback(
    callback: SolanaFailoverStateChangeCallback
  ): void {
    this.onFailoverStateChange = callback;
  }

  getChainName(): string {
    return this.config.chainName;
  }

  /** Report that this manager was created and cached. */
  reportCreated(): void {
    this.telemetry.event({
      type: RpcTelemetryEventType.CREATED,
      hasFallback: Boolean(this.config.fallbackRpcUrl),
    });
  }
}

// Cache managers by RPC URL combination to persist failover state across requests
const solanaManagerCache = new Map<string, SolanaProviderManager>();

export type CreateSolanaProviderManagerOptions = {
  primaryRpcUrl: string;
  fallbackRpcUrl?: string;
  maxRetries?: number;
  timeoutMs?: number;
  chainName?: string;
  commitment?: Commitment;
  metricsCollector?: SolanaRpcMetricsCollector;
  telemetry?: RpcTelemetrySink;
  onFailoverStateChange?: SolanaFailoverStateChangeCallback;
  /** See CreateRpcProviderManagerOptions.cacheKey. */
  cacheKey?: string;
};

export function createSolanaProviderManager(
  options: CreateSolanaProviderManagerOptions
): SolanaProviderManager {
  const cacheKey =
    options.cacheKey ??
    `${options.primaryRpcUrl}|${options.fallbackRpcUrl || ""}`;

  let manager = solanaManagerCache.get(cacheKey);
  if (!manager) {
    manager = new SolanaProviderManager({
      config: {
        primaryRpcUrl: options.primaryRpcUrl,
        fallbackRpcUrl: options.fallbackRpcUrl,
        maxRetries: options.maxRetries,
        timeoutMs: options.timeoutMs,
        chainName: options.chainName,
        commitment: options.commitment,
      },
      metricsCollector: options.metricsCollector,
      telemetry: options.telemetry,
      onFailoverStateChange: options.onFailoverStateChange,
    });
    solanaManagerCache.set(cacheKey, manager);
    manager.reportCreated();
  } else if (options.onFailoverStateChange) {
    manager.setFailoverStateChangeCallback(options.onFailoverStateChange);
  }

  return manager;
}

export function getAllSolanaFailoverStates(): Map<
  string,
  { chainName: string; isUsingFallback: boolean }
> {
  const states = new Map<
    string,
    { chainName: string; isUsingFallback: boolean }
  >();
  solanaManagerCache.forEach((manager, key) => {
    states.set(key, {
      chainName: manager.getChainName(),
      isUsingFallback: manager.isCurrentlyUsingFallback(),
    });
  });
  return states;
}

export function clearSolanaProviderManagerCache(): void {
  solanaManagerCache.clear();
}
