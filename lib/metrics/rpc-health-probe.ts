/**
 * Active RPC Health Probe
 *
 * Periodically pings every RPC endpoint (primary + fallback) with a
 * lightweight call (eth_blockNumber for EVM, getSlot for Solana) and
 * records up/down, latency, and error classification independent of
 * workflow traffic.
 *
 * Started lazily on first /api/metrics/api scrape via startRpcHealthProbe().
 */

import "server-only";

import { Connection } from "@solana/web3.js";
import { ErrorCategory, logSystemWarn } from "@/lib/logging";
import { classifyRpcError } from "@/lib/rpc/providers";
import { rpcProbeMetrics } from "./collectors/prometheus";
import type { ProbeChainConfig } from "./db-metrics";

function noop(): void {
  // intentional no-op for unhandled probe promise rejections
}

const PROBE_INTERVAL_MS = Number(process.env.RPC_PROBE_INTERVAL_MS) || 30_000;
const PROBE_TIMEOUT_MS = Number(process.env.RPC_PROBE_TIMEOUT_MS) || 5000;

type ProbeTarget = {
  chain: string;
  provider: "primary" | "fallback";
  url: string;
  chainType: string;
};

// Hot-reload safe: store timer on globalThis so restarts don't spawn duplicates
const globalForProbe = globalThis as unknown as {
  rpcProbeTimer: ReturnType<typeof setInterval> | undefined;
};

export function startRpcHealthProbe(): void {
  if (globalForProbe.rpcProbeTimer !== undefined) {
    return;
  }

  runProbeAllChains().catch(noop);
  globalForProbe.rpcProbeTimer = setInterval(() => {
    runProbeAllChains().catch(noop);
  }, PROBE_INTERVAL_MS);
  globalForProbe.rpcProbeTimer.unref();
}

export function stopRpcHealthProbe(): void {
  if (globalForProbe.rpcProbeTimer !== undefined) {
    clearInterval(globalForProbe.rpcProbeTimer);
    globalForProbe.rpcProbeTimer = undefined;
  }
}

async function runProbeAllChains(): Promise<void> {
  let chainConfigs: ProbeChainConfig[];
  try {
    const { getEnabledChainConfigsForProbe } = await import("./db-metrics");
    chainConfigs = await getEnabledChainConfigsForProbe();
  } catch (error: unknown) {
    logSystemWarn(
      ErrorCategory.DATABASE,
      "[RPC Probe] Failed to load chain configs",
      error
    );
    return;
  }

  const targets: ProbeTarget[] = [];

  for (const config of chainConfigs) {
    targets.push({
      chain: config.name,
      provider: "primary",
      url: config.defaultPrimaryRpc,
      chainType: config.chainType,
    });
    if (config.defaultFallbackRpc) {
      targets.push({
        chain: config.name,
        provider: "fallback",
        url: config.defaultFallbackRpc,
        chainType: config.chainType,
      });
    }
  }

  await Promise.allSettled(targets.map((t) => probeEndpoint(t)));
}

async function probeEndpoint(target: ProbeTarget): Promise<void> {
  const { chain, provider, url, chainType } = target;
  const start = performance.now();

  try {
    if (chainType === "solana") {
      await probeSolana(url);
    } else {
      await probeEvm(url);
    }

    const durationMs = performance.now() - start;
    const endpoint = extractHostname(url);
    rpcProbeMetrics.up.set({ chain, provider, endpoint }, 1);
    rpcProbeMetrics.latency.observe({ chain, provider }, durationMs);
    rpcProbeMetrics.lastSuccess.set({ chain, provider }, Date.now());
  } catch (error: unknown) {
    const durationMs = performance.now() - start;
    const endpoint = extractHostname(url);
    rpcProbeMetrics.up.set({ chain, provider, endpoint }, 0);
    rpcProbeMetrics.latency.observe({ chain, provider }, durationMs);

    const errorType = classifyRpcError(error);
    rpcProbeMetrics.errorsTotal.inc({
      chain,
      provider,
      error_type: errorType,
    });
  }
}

async function probeEvm(url: string): Promise<void> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "eth_blockNumber",
      params: [],
      id: 1,
    }),
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const data: { error?: { message?: string } } = await response.json();
  if (data.error) {
    throw new Error(data.error.message ?? "RPC error");
  }
}

async function probeSolana(url: string): Promise<void> {
  const connection = new Connection(url, { commitment: "confirmed" });
  await withTimeout(connection.getSlot(), PROBE_TIMEOUT_MS);
}

function extractHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise.then(
      (v) => {
        clearTimeout(timer);
        return v;
      },
      (e: unknown) => {
        clearTimeout(timer);
        throw e;
      }
    ),
    new Promise<T>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Timeout after ${timeoutMs}ms`)),
        timeoutMs
      );
    }),
  ]);
}
