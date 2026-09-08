import { afterEach, describe, expect, it } from "vitest";
import { metrics, registry } from "../../lib/metrics.js";

describe("block dispatcher metrics", () => {
  afterEach(() => {
    metrics.resetForTests();
  });

  // -------------------------------------------------------------------------
  // Counters
  // -------------------------------------------------------------------------

  describe("counters", () => {
    it("records block received per chain", async () => {
      metrics.recordBlockReceived("Ethereum Mainnet");
      metrics.recordBlockReceived("Ethereum Mainnet");
      metrics.recordBlockReceived("Avalanche");

      const text = await registry.metrics();
      expect(text).toContain(
        'keeperhub_block_dispatcher_blocks_received_total{chain="Ethereum Mainnet"} 2',
      );
      expect(text).toContain(
        'keeperhub_block_dispatcher_blocks_received_total{chain="Avalanche"} 1',
      );
    });

    it("records ws close with the reason label", async () => {
      metrics.recordWsClose("Ethereum Mainnet", "block_advance_timeout");
      metrics.recordWsClose("Ethereum Mainnet", "pong_timeout");
      metrics.recordWsClose("Avalanche", "upstream_close");

      const text = await registry.metrics();
      expect(text).toContain(
        'keeperhub_block_dispatcher_ws_closes_total{chain="Ethereum Mainnet",reason="block_advance_timeout"} 1',
      );
      expect(text).toContain(
        'keeperhub_block_dispatcher_ws_closes_total{chain="Ethereum Mainnet",reason="pong_timeout"} 1',
      );
      expect(text).toContain(
        'keeperhub_block_dispatcher_ws_closes_total{chain="Avalanche",reason="upstream_close"} 1',
      );
    });

    it("records reconnect outcomes", async () => {
      metrics.recordReconnect("Ethereum Mainnet", "success");
      metrics.recordReconnect("Ethereum Mainnet", "success");
      metrics.recordReconnect("Avalanche", "exhausted");

      const text = await registry.metrics();
      expect(text).toContain(
        'keeperhub_block_dispatcher_reconnects_total{chain="Ethereum Mainnet",outcome="success"} 2',
      );
      expect(text).toContain(
        'keeperhub_block_dispatcher_reconnects_total{chain="Avalanche",outcome="exhausted"} 1',
      );
    });

    it("records url flips with direction", async () => {
      metrics.recordUrlFlip("Ethereum Mainnet", "to_fallback");
      metrics.recordUrlFlip("Ethereum Mainnet", "to_primary");

      const text = await registry.metrics();
      expect(text).toContain(
        'keeperhub_block_dispatcher_url_flips_total{chain="Ethereum Mainnet",direction="to_fallback"} 1',
      );
      expect(text).toContain(
        'keeperhub_block_dispatcher_url_flips_total{chain="Ethereum Mainnet",direction="to_primary"} 1',
      );
    });

    it("records sqs enqueue outcomes", async () => {
      metrics.recordSqsEnqueue("Ethereum Mainnet", "success");
      metrics.recordSqsEnqueue("Ethereum Mainnet", "success");
      metrics.recordSqsEnqueue("Ethereum Mainnet", "error");

      const text = await registry.metrics();
      expect(text).toContain(
        'keeperhub_block_dispatcher_sqs_enqueue_total{chain="Ethereum Mainnet",outcome="success"} 2',
      );
      expect(text).toContain(
        'keeperhub_block_dispatcher_sqs_enqueue_total{chain="Ethereum Mainnet",outcome="error"} 1',
      );
    });

    it("records unhandled rejection without chain label", async () => {
      metrics.recordUnhandledRejection();
      metrics.recordUnhandledRejection();

      const text = await registry.metrics();
      expect(text).toMatch(
        /keeperhub_block_dispatcher_unhandled_rejections_total\s+2/,
      );
    });
  });

  // -------------------------------------------------------------------------
  // State gauges (set / read back via /metrics output)
  // -------------------------------------------------------------------------

  describe("state gauges", () => {
    it("reflects is_alive flips", async () => {
      metrics.setIsAlive("Ethereum Mainnet", true);
      metrics.setIsAlive("Avalanche", false);

      const text = await registry.metrics();
      expect(text).toContain(
        'keeperhub_block_dispatcher_is_alive{chain="Ethereum Mainnet"} 1',
      );
      expect(text).toContain(
        'keeperhub_block_dispatcher_is_alive{chain="Avalanche"} 0',
      );
    });

    it("reflects current_url_index", async () => {
      metrics.setCurrentUrlIndex("Ethereum Mainnet", 1);
      metrics.setCurrentUrlIndex("Avalanche", 0);

      const text = await registry.metrics();
      expect(text).toContain(
        'keeperhub_block_dispatcher_current_url_index{chain="Ethereum Mainnet"} 1',
      );
      expect(text).toContain(
        'keeperhub_block_dispatcher_current_url_index{chain="Avalanche"} 0',
      );
    });

    it("reflects last_processed_block, workflows_tracked, chains_monitored", async () => {
      metrics.setLastProcessedBlock("Ethereum Mainnet", 25_088_123);
      metrics.setWorkflowsTracked("Ethereum Mainnet", 4);
      metrics.setChainsMonitored(3);

      const text = await registry.metrics();
      expect(text).toContain(
        'keeperhub_block_dispatcher_last_processed_block{chain="Ethereum Mainnet"} 25088123',
      );
      expect(text).toContain(
        'keeperhub_block_dispatcher_workflows_tracked{chain="Ethereum Mainnet"} 4',
      );
      expect(text).toMatch(/keeperhub_block_dispatcher_chains_monitored\s+3/);
    });
  });

  // -------------------------------------------------------------------------
  // Scrape-time callbacks: seconds_since_last_block, socket_age_seconds
  // -------------------------------------------------------------------------

  describe("scrape-time gauges", () => {
    it("emits seconds_since_last_block from snapshot at scrape time", async () => {
      const tenSecondsAgo = Date.now() - 10_000;
      metrics.setLastBlockAdvanceAt("Ethereum Mainnet", tenSecondsAgo);

      const text = await registry.metrics();
      const match = text.match(
        /keeperhub_block_dispatcher_seconds_since_last_block\{chain="Ethereum Mainnet"\} (\S+)/,
      );
      expect(match).not.toBeNull();
      const value = Number(match?.[1]);
      // Wall-clock between setLastBlockAdvanceAt and the scrape: ~10s. Allow
      // a generous window for CI jitter.
      expect(value).toBeGreaterThanOrEqual(9.5);
      expect(value).toBeLessThan(15);
    });

    it("emits socket_age_seconds from snapshot at scrape time", async () => {
      const fiveSecondsAgo = Date.now() - 5_000;
      metrics.setSubscribedAt("Ethereum Mainnet", fiveSecondsAgo);

      const text = await registry.metrics();
      const match = text.match(
        /keeperhub_block_dispatcher_socket_age_seconds\{chain="Ethereum Mainnet"\} (\S+)/,
      );
      expect(match).not.toBeNull();
      const value = Number(match?.[1]);
      expect(value).toBeGreaterThanOrEqual(4.5);
      expect(value).toBeLessThan(10);
    });

    it("forgetChain drops every per-chain gauge labelset so closed chains disappear from /metrics", async () => {
      // Populate every per-chain gauge for two chains so we can confirm that
      // forgetChain only wipes the one we asked for.
      const now = Date.now();
      for (const chain of ["Ethereum Mainnet", "Avalanche"]) {
        metrics.setLastBlockAdvanceAt(chain, now);
        metrics.setSubscribedAt(chain, now);
        metrics.setIsAlive(chain, true);
        metrics.setIsReconnecting(chain, false);
        metrics.setHasActiveSubscription(chain, true);
        metrics.setCurrentUrlIndex(chain, 0);
        metrics.setSilentReconnectsCurrent(chain, 0);
        metrics.setLastProcessedBlock(chain, 100);
        metrics.setWorkflowsTracked(chain, 1);
      }

      metrics.forgetChain("Ethereum Mainnet");
      const text = await registry.metrics();

      // No labelset for the forgotten chain anywhere. Without forgetChain
      // calling .remove() on each gauge, prom-client would keep emitting the
      // last value of these labels forever — exactly the behaviour that
      // would make the alert fire for chains we no longer monitor.
      for (const gaugeName of [
        "seconds_since_last_block",
        "socket_age_seconds",
        "is_alive",
        "is_reconnecting",
        "has_active_subscription",
        "current_url_index",
        "silent_reconnects_current",
        "last_processed_block",
        "workflows_tracked",
      ]) {
        expect(text).not.toContain(
          `keeperhub_block_dispatcher_${gaugeName}{chain="Ethereum Mainnet"}`,
        );
        // The other chain stays.
        expect(text).toContain(
          `keeperhub_block_dispatcher_${gaugeName}{chain="Avalanche"}`,
        );
      }
    });
  });

  // -------------------------------------------------------------------------
  // Histograms
  // -------------------------------------------------------------------------

  describe("histograms", () => {
    it("observes reconnect duration into the right buckets", async () => {
      metrics.observeReconnectDuration("Ethereum Mainnet", 500);
      metrics.observeReconnectDuration("Ethereum Mainnet", 1500);
      metrics.observeReconnectDuration("Ethereum Mainnet", 35_000);

      const text = await registry.metrics();
      // Count bucket totals for the three observations.
      expect(text).toContain(
        'keeperhub_block_dispatcher_reconnect_duration_ms_count{chain="Ethereum Mainnet"} 3',
      );
      // The 500ms one falls in le=500; le=500 should be 1.
      expect(text).toContain(
        'keeperhub_block_dispatcher_reconnect_duration_ms_bucket{le="500",chain="Ethereum Mainnet"} 1',
      );
      // 500 + 1500 are both <= 2000; le=2000 should be 2.
      expect(text).toContain(
        'keeperhub_block_dispatcher_reconnect_duration_ms_bucket{le="2000",chain="Ethereum Mainnet"} 2',
      );
    });

    it("observes block lag into the right buckets", async () => {
      metrics.observeBlockLag("Ethereum Mainnet", 1);
      metrics.observeBlockLag("Ethereum Mainnet", 4);
      metrics.observeBlockLag("Ethereum Mainnet", 200);

      const text = await registry.metrics();
      expect(text).toContain(
        'keeperhub_block_dispatcher_block_lag_seconds_count{chain="Ethereum Mainnet"} 3',
      );
      expect(text).toContain(
        'keeperhub_block_dispatcher_block_lag_seconds_bucket{le="5",chain="Ethereum Mainnet"} 2',
      );
    });
  });
});
