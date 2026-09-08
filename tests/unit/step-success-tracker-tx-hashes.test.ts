/**
 * KEEP-470: tracker for TransactionHashEntry list.
 *
 * The tracker is module-level state in step-success-tracker.ts; each test
 * uses a unique executionId so they remain isolated without needing to
 * re-import the module.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type { StepContext } from "@/lib/workflow/executor/step-handler";
import {
  clearExecution,
  getTransactionHashes,
  recordTransactionHashIfPresent,
} from "@/lib/workflow/executor/step-success-tracker";

const SOLANA_SIGNATURE =
  "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW";

function ctx(overrides: Partial<StepContext> = {}): StepContext {
  return {
    executionId: "exec_keep_470_default",
    nodeId: "write-contract-1",
    nodeName: "Write Contract",
    nodeType: "web3/write-contract",
    ...overrides,
  };
}

describe("recordTransactionHashIfPresent (KEEP-470)", () => {
  it("records a hash with node + chain context when output has a 0x string", () => {
    const executionId = "exec_basic";
    recordTransactionHashIfPresent(ctx({ executionId }), {
      transactionHash: "0xabc123",
      chainId: 1,
      network: "mainnet",
    });

    expect(getTransactionHashes(executionId)).toEqual([
      {
        hash: "0xabc123",
        nodeId: "write-contract-1",
        nodeName: "Write Contract",
        chainId: 1,
        network: "mainnet",
      },
    ]);

    clearExecution(executionId);
  });

  it("preserves submission order across multiple successful steps", () => {
    const executionId = "exec_order";
    recordTransactionHashIfPresent(
      ctx({ executionId, nodeId: "approve-1", nodeName: "Approve" }),
      { transactionHash: "0x111", chainId: 1, network: "mainnet" }
    );
    recordTransactionHashIfPresent(
      ctx({ executionId, nodeId: "swap-1", nodeName: "Swap" }),
      { transactionHash: "0x222", chainId: 1, network: "mainnet" }
    );

    const entries = getTransactionHashes(executionId);
    expect(entries).toHaveLength(2);
    expect(entries[0].hash).toBe("0x111");
    expect(entries[0].nodeId).toBe("approve-1");
    expect(entries[1].hash).toBe("0x222");
    expect(entries[1].nodeId).toBe("swap-1");

    clearExecution(executionId);
  });

  it("omits optional fields when output lacks them (non-web3 step)", () => {
    const executionId = "exec_no_chain";
    recordTransactionHashIfPresent(ctx({ executionId }), {
      transactionHash: "0xnochain",
    });

    const entries = getTransactionHashes(executionId);
    expect(entries[0]).toEqual({
      hash: "0xnochain",
      nodeId: "write-contract-1",
      nodeName: "Write Contract",
    });
    expect("chainId" in entries[0]).toBe(false);
    expect("network" in entries[0]).toBe(false);

    clearExecution(executionId);
  });

  it("omits iterationIndex when context is not from a For-Each", () => {
    const executionId = "exec_no_loop";
    recordTransactionHashIfPresent(ctx({ executionId }), {
      transactionHash: "0xloopless",
      chainId: 1,
      network: "mainnet",
    });

    expect("iterationIndex" in getTransactionHashes(executionId)[0]).toBe(
      false
    );

    clearExecution(executionId);
  });

  it("includes iterationIndex for For-Each iterations and keeps all of them", () => {
    const executionId = "exec_foreach";
    for (let i = 0; i < 3; i++) {
      recordTransactionHashIfPresent(
        ctx({
          executionId,
          nodeId: "transfer-funds-1",
          nodeName: "Send airdrop",
          iterationIndex: i,
        }),
        {
          transactionHash: `0xfan${i}`,
          chainId: 1,
          network: "mainnet",
        }
      );
    }

    const entries = getTransactionHashes(executionId);
    expect(entries).toHaveLength(3);
    expect(entries.map((e) => e.iterationIndex)).toEqual([0, 1, 2]);
    expect(entries.map((e) => e.hash)).toEqual(["0xfan0", "0xfan1", "0xfan2"]);
    // Same nodeId/nodeName across iterations.
    expect(new Set(entries.map((e) => e.nodeId))).toEqual(
      new Set(["transfer-funds-1"])
    );

    clearExecution(executionId);
  });

  it("ignores outputs that lack a transactionHash field", () => {
    const executionId = "exec_no_hash";
    recordTransactionHashIfPresent(ctx({ executionId }), {
      result: "some other thing",
    });
    recordTransactionHashIfPresent(ctx({ executionId }), undefined);
    recordTransactionHashIfPresent(ctx({ executionId }), null);
    recordTransactionHashIfPresent(ctx({ executionId }), "a string output");

    expect(getTransactionHashes(executionId)).toEqual([]);

    clearExecution(executionId);
  });

  it("ignores transactionHash values that are not 0x-prefixed strings", () => {
    const executionId = "exec_bad_hash";
    recordTransactionHashIfPresent(ctx({ executionId }), {
      transactionHash: "not-a-hash",
    });
    recordTransactionHashIfPresent(ctx({ executionId }), {
      transactionHash: 12_345,
    });
    recordTransactionHashIfPresent(ctx({ executionId }), {
      transactionHash: "",
    });

    expect(getTransactionHashes(executionId)).toEqual([]);

    clearExecution(executionId);
  });

  it("records a base58 signature when the step reported a Solana chainId", () => {
    const executionId = "exec_solana";
    recordTransactionHashIfPresent(ctx({ executionId }), {
      transactionHash: SOLANA_SIGNATURE,
      chainId: 101,
      network: "solana-mainnet",
    });

    expect(getTransactionHashes(executionId)).toEqual([
      {
        hash: SOLANA_SIGNATURE,
        nodeId: "write-contract-1",
        nodeName: "Write Contract",
        chainId: 101,
        network: "solana-mainnet",
      },
    ]);

    clearExecution(executionId);
  });

  it("ignores a Solana chainId whose hash is not a 64-byte base58 signature", () => {
    const executionId = "exec_solana_junk";
    recordTransactionHashIfPresent(ctx({ executionId }), {
      transactionHash: "not a signature",
      chainId: 101,
    });
    // Valid base58, wrong length (a pubkey, not a signature).
    recordTransactionHashIfPresent(ctx({ executionId }), {
      transactionHash: "So11111111111111111111111111111111111111112",
      chainId: 101,
    });
    // 0x-hex is not what a Solana chain produces either.
    recordTransactionHashIfPresent(ctx({ executionId }), {
      transactionHash: "0xabc123",
      chainId: 101,
    });

    expect(getTransactionHashes(executionId)).toEqual([]);

    clearExecution(executionId);
  });

  // The Solana steps that report no chainId (transfer-spl-token,
  // call-solana-program-anchor, send-raw-solana-instruction) stay dropped:
  // reconcileTransactionHashes fails a batch conclusively for a hash it cannot
  // attribute to a chain, so recording theirs would fail runs that succeeded.
  it("ignores a base58 signature from a step that reported no chainId", () => {
    const executionId = "exec_solana_no_chain";
    recordTransactionHashIfPresent(ctx({ executionId }), {
      transactionHash: SOLANA_SIGNATURE,
      network: "solana-mainnet",
    });

    expect(getTransactionHashes(executionId)).toEqual([]);

    clearExecution(executionId);
  });

  it("no-ops when context has no executionId (anonymous direct execution)", () => {
    // executionId is optional on StepContext for direct executions.
    recordTransactionHashIfPresent(
      { ...ctx(), executionId: undefined },
      { transactionHash: "0xfoo" }
    );
    // Nothing should leak under any key.
    expect(getTransactionHashes("anything")).toEqual([]);
  });

  it("clearExecution wipes the tracker for that execution only", () => {
    const a = "exec_a";
    const b = "exec_b";
    recordTransactionHashIfPresent(ctx({ executionId: a }), {
      transactionHash: "0xa",
    });
    recordTransactionHashIfPresent(ctx({ executionId: b }), {
      transactionHash: "0xb",
    });

    clearExecution(a);
    expect(getTransactionHashes(a)).toEqual([]);
    expect(getTransactionHashes(b)).toHaveLength(1);

    clearExecution(b);
  });

  it("getTransactionHashes returns empty array for unknown executionId", () => {
    expect(getTransactionHashes("never-tracked")).toEqual([]);
  });

  it("getTransactionHashes returns a defensive copy that callers cannot use to mutate tracker state", () => {
    const executionId = "exec_defensive_copy";
    recordTransactionHashIfPresent(ctx({ executionId }), {
      transactionHash: "0xoriginal",
      chainId: 1,
      network: "mainnet",
    });

    const first = getTransactionHashes(executionId);
    expect(first).toHaveLength(1);

    // Mutate the returned array: push, splice, reverse, clear.
    first.push({
      hash: "0xinjected",
      nodeId: "evil",
      nodeName: "Evil",
    });
    first.splice(0, first.length);

    // The next read must reflect the tracker's untouched state, not the
    // mutated view the caller held.
    const second = getTransactionHashes(executionId);
    expect(second).toHaveLength(1);
    expect(second[0].hash).toBe("0xoriginal");
    // And each call returns a fresh array (different identity).
    expect(second).not.toBe(first);

    clearExecution(executionId);
  });
});
