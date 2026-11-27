import { ethers, isError } from "ethers";
import {
  ErrorCategory,
  logSystemError,
  logSystemWarn,
  logUserError,
} from "@/lib/logging";
import { sleep } from "@/lib/sleep";
import { isConnectionRefusal } from "../connection-refusal";
import { RPC_ENDPOINT, type RpcEndpoint } from "../rpc-endpoint";
import { safeEthersGetUrl } from "../safe-ethers-fetch";
import { redactAllUrls, scrubRpcUrls } from "../scrub-rpc-urls";
import {
  isNonRetryableError,
  isTransportFailure,
  RPC_CONNECTION_ERROR_PATTERNS,
} from "./error-classification";
import {
  PrivateRelayUnavailableError,
  RpcRedirectError,
  RpcRelayTransportError,
  RpcUserEndpointError,
} from "./transport-error";

export {
  isNonRetryableError,
  isTransportFailure,
  NON_RETRYABLE_ERROR_CODES,
  RPC_CONNECTION_ERROR_PATTERNS,
} from "./error-classification";
export {
  declaredErrorClass,
  InvalidSendModeError,
  PrivateRelayUnavailableError,
  RpcRedirectError,
  RpcRelayTransportError,
  RpcUserEndpointError,
  rpcRelayErrorClass,
} from "./transport-error";

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
    provider: RpcEndpoint,
    operation?: RpcOperationType
  ): void;
  recordLatency(
    chainName: string,
    provider: RpcEndpoint,
    durationMs: number,
    operation?: RpcOperationType
  ): void;
  recordErrorType(
    chainName: string,
    provider: RpcEndpoint,
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

// Block poll during a receipt wait; ethers' 4s default held the wallet lock longer.
const RECEIPT_POLL_INTERVAL_MS = 1000;

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
    _provider: RpcEndpoint,
    _operation?: RpcOperationType
  ) => {
    /* noop */
  },
  recordLatency: (
    _chain: string,
    _provider: RpcEndpoint,
    _durationMs: number,
    _operation?: RpcOperationType
  ) => {
    /* noop */
  },
  recordErrorType: (
    _chain: string,
    _provider: RpcEndpoint,
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
  // Extra public RPCs a signed write is also sent to (chains.broadcast_rpc_urls).
  broadcastRpcUrls?: readonly string[];
  // True when every endpoint but the relay is the user's own RPC preference.
  userRpc?: boolean;
};

export type RpcProviderMetrics = {
  primaryAttempts: number;
  primaryFailures: number;
  fallbackAttempts: number;
  fallbackFailures: number;
  totalRequests: number;
  lastFailoverTime: Date | null;
};

type EndpointFailure = {
  endpoint: RpcEndpoint;
  transport?: boolean;
  allAttemptsConnectionRefused?: boolean;
  allAttemptsRedirected?: boolean;
  // The endpoint's last error as thrown: never rendered, only kept on the failover error.
  lastError?: Error;
};

/** Only the flags the failover summary reads, not the attempt's result or text. */
function endpointFailure(
  endpoint: EndpointFailure["endpoint"],
  attempt: Omit<EndpointFailure, "endpoint">
): EndpointFailure {
  return {
    endpoint,
    transport: attempt.transport,
    allAttemptsConnectionRefused: attempt.allAttemptsConnectionRefused,
    allAttemptsRedirected: attempt.allAttemptsRedirected,
    lastError: attempt.lastError,
  };
}

// An endpoint error that marks the node as answering but behind the chain, not down.
const laggedOnly = (failures: readonly EndpointFailure[]): boolean =>
  failures.length > 0 &&
  failures.every(
    (failure) =>
      (failure.lastError as { rpcLagging?: unknown } | undefined)
        ?.rpcLagging === true
  );

/**
 * The last endpoint error behind a failover error, if any. Kept off `cause`:
 * getErrorMessage and connection-refusal checks read `cause`, so it would change them.
 */
export function lastEndpointErrorOf(error: unknown): Error | undefined {
  const kept = (error as { lastEndpointError?: unknown } | null)
    ?.lastEndpointError;
  return kept instanceof Error ? kept : undefined;
}

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
      broadcastRpcUrls: config.broadcastRpcUrls ?? [],
      userRpc: config.userRpc ?? false,
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
        pollingInterval: RECEIPT_POLL_INTERVAL_MS,
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

  /** True when this provider is the private relay the swap put on the primary. */
  isPrivateRelayProvider(provider: ethers.JsonRpcProvider): boolean {
    return (
      this.config.primaryIsPrivateRelay && provider === this.primaryProvider
    );
  }

  /** True when the private-mempool swap put the relay on the primary. */
  hasPrivateRelayPrimary(): boolean {
    return this.config.primaryIsPrivateRelay;
  }

  // Relay URL and chain pairs seen to match, and mismatches already alerted on.
  private static readonly verifiedRelayChains = new Set<string>();
  private static readonly reportedRelayChains = new Set<string>();

  /**
   * Refuses a relay that serves another chain (e.g. a mainnet relay set for a
   * testnet), checked once per relay and chain. An unreachable relay is left
   * to fail on the send itself.
   */
  async assertPrivateRelayChain(): Promise<void> {
    const key = `${this.config.primaryRpcUrl}|${this.config.chainId}`;
    if (
      !this.config.primaryIsPrivateRelay ||
      RpcProviderManager.verifiedRelayChains.has(key)
    ) {
      return;
    }
    let served: bigint;
    try {
      served = BigInt(
        (await this.getPrimaryProvider().send("eth_chainId", [])) as string
      );
    } catch {
      // Safe to skip: a transaction signed for this chain is invalid on any
      // other (EIP-155); a public fallback exists only under strict: false.
      return;
    }
    if (served !== BigInt(this.config.chainId)) {
      const error = new PrivateRelayUnavailableError(
        `This step is set to Send as: Private relay, but the private relay for ${this.config.chainName} is misconfigured (it serves chain ${served}, not ${this.config.chainId}). Set Send as to Normal transaction (sendMode: "transaction") only if a public send is acceptable.`
      );
      // Our configuration is wrong: alert once per relay and chain; the step fails as USER.
      if (!RpcProviderManager.reportedRelayChains.has(key)) {
        RpcProviderManager.reportedRelayChains.add(key);
        logSystemError(
          ErrorCategory.CONFIGURATION,
          "[RPC] Private relay serves another chain",
          error,
          { chain_id: String(this.config.chainId) }
        );
      }
      throw error;
    }
    RpcProviderManager.verifiedRelayChains.add(key);
  }

  /** Extra public broadcast URLs. The one place that keeps them off relay sends. */
  getBroadcastRpcUrls(): readonly string[] {
    return this.config.primaryIsPrivateRelay
      ? []
      : this.config.broadcastRpcUrls;
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
          RPC_ENDPOINT.FALLBACK,
          this.config.maxRetries,
          operationType
        );

        if (fallbackResult.success) {
          this.metricsCollector.recordSuccess(
            this.config.chainName,
            RPC_ENDPOINT.FALLBACK,
            operationType
          );
          return fallbackResult.result as T;
        }

        // Fallback failed - try primary in case it recovered. Not an outage
        // yet, so a Sentry warning with no error metric and no page.
        logSystemWarn(
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
          RPC_ENDPOINT.PRIMARY,
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
              previousState: RPC_ENDPOINT.FALLBACK,
              newState: RPC_ENDPOINT.PRIMARY,
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
        const failures = [
          endpointFailure(RPC_ENDPOINT.FALLBACK, fallbackResult),
          endpointFailure(RPC_ENDPOINT.PRIMARY, primaryResult),
        ];
        // A platform fault (error level, system-error metric) unless the user's
        // own URL redirected. The Sentry event only reaches Sentry from the
        // Next.js runtimes - the workflow-runner pods initialise no Sentry client.
        this.reportBothFailed(
          failures,
          `Fallback: ${fallbackResult.error}. Primary: ${primaryResult.error}`
        );
        // Thrown messages reach end users via step errors; drop provider
        // URLs entirely (host included). Internal logs above keep the
        // host-visible masked form.
        throw this.failoverError(
          `RPC failed on both endpoints. Fallback: ${fallbackResult.error}. Primary: ${primaryResult.error}`,
          failures
        );
      }
    }

    // Normal path: try primary first, then fallback
    const primaryProvider = this.getPrimaryProvider();
    const primaryResult = await this.tryProvider(
      primaryProvider,
      operation,
      RPC_ENDPOINT.PRIMARY,
      this.config.maxRetries,
      operationType
    );

    if (primaryResult.success) {
      this.metricsCollector.recordSuccess(
        this.config.chainName,
        RPC_ENDPOINT.PRIMARY,
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
        RPC_ENDPOINT.FALLBACK,
        this.config.maxRetries,
        operationType
      );

      if (fallbackResult.success) {
        // The call was served, so this is a recovery event rather than an
        // outage: Sentry warning, no error metric, no page.
        logSystemWarn(
          ErrorCategory.NETWORK_RPC,
          `[RPC] Primary RPC failed for ${this.config.chainName}, switching to fallback`,
          primaryResult.error,
          {
            event: "RPC_FAILOVER_ACTIVATED",
            chain: this.config.chainName,
            previous_state: RPC_ENDPOINT.PRIMARY,
            new_state: RPC_ENDPOINT.FALLBACK,
          }
        );
        // A relay manager tries the relay first on every call: one refused
        // read must not send later transactions to the public fallback.
        if (!this.config.primaryIsPrivateRelay) {
          this.isUsingFallback = true;
          this.onFailoverStateChange?.(this.config.chainName, true, "failover");
        }
        return fallbackResult.result as T;
      }

      const failures = [
        endpointFailure(RPC_ENDPOINT.PRIMARY, primaryResult),
        endpointFailure(RPC_ENDPOINT.FALLBACK, fallbackResult),
      ];
      this.reportBothFailed(
        failures,
        `Primary: ${primaryResult.error}. Fallback: ${fallbackResult.error}`
      );
      throw this.failoverError(
        `RPC failed on both endpoints. Primary: ${primaryResult.error}. Fallback: ${fallbackResult.error}`,
        failures
      );
    }

    throw this.failoverError(
      `RPC failed on primary endpoint: ${primaryResult.error}`,
      [endpointFailure(RPC_ENDPOINT.PRIMARY, primaryResult)]
    );
  }

  /** True when every failure is a redirect from the user's own RPC preference. */
  private onlyUserRedirects(failures: readonly EndpointFailure[]): boolean {
    return (
      failures.length > 0 &&
      failures.every(
        (failure) =>
          failure.allAttemptsRedirected === true &&
          this.config.userRpc &&
          !(
            failure.endpoint === RPC_ENDPOINT.PRIMARY &&
            this.config.primaryIsPrivateRelay
          )
      )
    );
  }

  /** Both endpoints failed: a platform fault, unless the user's own URL redirected. */
  private reportBothFailed(
    failures: readonly EndpointFailure[],
    detail: string
  ): void {
    if (this.onlyUserRedirects(failures)) {
      logUserError(
        ErrorCategory.CONFIGURATION,
        `[RPC] User RPC preference redirected for ${this.config.chainName}`,
        detail,
        { event: "RPC_USER_ENDPOINT_REDIRECT", chain: this.config.chainName }
      );
      return;
    }
    // Both answered but stayed behind the block a run waits for: lag, not an outage.
    if (laggedOnly(failures)) {
      logSystemWarn(
        ErrorCategory.NETWORK_RPC,
        `[RPC] Both primary and fallback RPC are behind for ${this.config.chainName}`,
        detail,
        { event: "RPC_BOTH_ENDPOINTS_LAGGING", chain: this.config.chainName }
      );
      return;
    }
    this.metricsCollector.recordBothFailed(this.config.chainName);
    logSystemError(
      ErrorCategory.NETWORK_RPC,
      `[RPC] Both primary and fallback RPC failed for ${this.config.chainName}`,
      detail,
      {
        event: "RPC_BOTH_ENDPOINTS_FAILED",
        chain: this.config.chainName,
      }
    );
  }

  /**
   * Build the error for an exhausted failover round.
   *
   * Becomes a relay error only when the round never touched an endpoint we
   * operate AND every attempt failed on transport. In practice that is the
   * strict private-mempool case, where the swap left the relay as the only
   * endpoint. A round where only the user's own RPC preference redirected is
   * a user error. Anything else stays a plain Error so the message classifier
   * keeps deciding, which for RPC means a platform fault.
   */
  private failoverError(
    message: string,
    failures: readonly EndpointFailure[]
  ): Error {
    if (this.onlyUserRedirects(failures)) {
      // The user's own URL: their configuration, not a platform fault. It took the bytes.
      return Object.assign(
        new RpcUserEndpointError(
          `Your RPC preference for ${this.config.chainName} answered with a redirect, which is not followed; set it to the final https:// address`
        ),
        { allAttemptsConnectionRefused: false }
      );
    }
    const redacted = redactAllUrls(message);
    const allAttemptsConnectionRefused =
      failures.length > 0 &&
      failures.every(
        (failure) => failure.allAttemptsConnectionRefused === true
      );
    const allOnTheRelay = failures.every(
      (failure) =>
        failure.transport &&
        failure.endpoint === RPC_ENDPOINT.PRIMARY &&
        this.config.primaryIsPrivateRelay
    );
    const result = allOnTheRelay
      ? new RpcRelayTransportError(redacted)
      : new Error(redacted);
    // A write-broadcast classifier must know whether *every retry attempt*
    // was refused. The rendered message only contains each endpoint's final
    // error, so text alone can turn "timeout, then refused" into "never sent".
    // Duck-typed by submit-signed.ts to avoid coupling callers to this class.
    Object.assign(result, { allAttemptsConnectionRefused });
    // Non-enumerable, so logs and JSON never carry the unscrubbed endpoint error.
    Object.defineProperty(result, "lastEndpointError", {
      value: failures.at(-1)?.lastError,
    });
    return result;
  }

  private recordAttempt(
    providerType: RpcEndpoint,
    operationType: RpcOperationType = "read"
  ): void {
    if (providerType === RPC_ENDPOINT.PRIMARY) {
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
    providerType: RpcEndpoint,
    operationType: RpcOperationType = "read"
  ): void {
    if (providerType === RPC_ENDPOINT.PRIMARY) {
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
    // The same URL redirects again: move on to the next endpoint.
    if (error instanceof RpcRedirectError) {
      return null;
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
    providerType: RpcEndpoint,
    maxRetries: number,
    operationType: RpcOperationType = "read"
  ): Promise<{
    success: boolean;
    result?: T;
    error?: string;
    /** Whether the last attempt failed on transport rather than on an answer. */
    transport?: boolean;
    /** True only when every retry attempt ended in a connection refusal. */
    allAttemptsConnectionRefused?: boolean;
    allAttemptsRedirected?: boolean;
    lastError?: Error;
  }> {
    let lastError: Error | undefined;
    let attemptCount = 0;
    let allAttemptsConnectionRefused = true;
    let allAttemptsRedirected = true;

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
        attemptCount += 1;
        allAttemptsConnectionRefused =
          allAttemptsConnectionRefused && isConnectionRefusal(error);
        allAttemptsRedirected =
          allAttemptsRedirected && error instanceof RpcRedirectError;
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
      allAttemptsRedirected: attemptCount > 0 && allAttemptsRedirected,
      lastError,
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

  getCurrentProviderType(): RpcEndpoint {
    return this.isUsingFallback ? RPC_ENDPOINT.FALLBACK : RPC_ENDPOINT.PRIMARY;
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
  broadcastRpcUrls?: readonly string[];
  userRpc?: boolean;
  metricsCollector?: RpcMetricsCollector;
  onFailoverStateChange?: FailoverStateChangeCallback;
};

export function createRpcProviderManager(
  options: CreateRpcProviderManagerOptions
): RpcProviderManager {
  const cacheKey = `${options.primaryRpcUrl}|${options.fallbackRpcUrl || ""}|${options.chainId ?? ""}|${options.primaryIsPrivateRelay ? "relay" : ""}|${(options.broadcastRpcUrls ?? []).join(",")}|${options.userRpc ? "user" : ""}`;

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
        broadcastRpcUrls: options.broadcastRpcUrls,
        userRpc: options.userRpc,
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
