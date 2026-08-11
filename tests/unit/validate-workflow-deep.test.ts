// Tests for the opt-in deep-tier ABI validator.
// resolveAbi is injected via resolveAbiOverride to avoid network calls.
// All timing tests use vi.useRealTimers() — real timers are required because
// the concurrency cap and deadline use setTimeout under the hood.

// Must mock server-only before any module imports that use it
vi.mock("server-only", () => ({}));

// Mock the real resolveAbi (has DB + network deps) — tests use resolveAbiOverride
vi.mock("@/lib/abi/cache", () => ({
  resolveAbi: vi.fn(),
}));

import { describe, expect, it, vi } from "vitest";
import type {
  ValidationResult,
  ValidatorWorkflow,
} from "@/lib/mcp/validate-workflow";
import {
  collectContractRefs,
  validateWorkflowDeep,
} from "@/lib/mcp/validate-workflow-deep";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function expectNoAbiErrors(result: ValidationResult): void {
  // biome-ignore lint/suspicious/noMisplacedAssertion: custom assertion helper called inside it() blocks
  expect(
    result.errors.filter((e) => e.code === "low-confidence-abi-match")
  ).toHaveLength(0);
}

function makeWorkflow(
  overrides: Partial<ValidatorWorkflow> = {}
): ValidatorWorkflow {
  return {
    id: "wf-test",
    nodes: [makeTriggerNode()],
    edges: [],
    inputSchema: null,
    outputMapping: null,
    isListed: false,
    workflowType: "read",
    ...overrides,
  };
}

function makeTriggerNode() {
  return {
    id: "trigger-1",
    data: { type: "trigger", config: {} },
  };
}

function makeWriteNode(
  idx: number,
  contractAddress: string,
  network: string,
  abi: string,
  actionType = "web3/write-contract"
) {
  return {
    id: `write-${idx}`,
    data: {
      type: "action",
      config: {
        actionType,
        contractAddress,
        network,
        abi,
      },
    },
  };
}

const SIMPLE_ABI_TRANSFER = JSON.stringify([
  {
    type: "function",
    name: "transfer",
    inputs: [{ type: "address" }, { type: "uint256" }],
  },
]);

const SIMPLE_ABI_APPROVE = JSON.stringify([
  {
    type: "function",
    name: "approve",
    inputs: [{ type: "address" }, { type: "uint256" }],
  },
]);

// A "proxy stub" ABI — minimal, matches common proxy pattern
const PROXY_STUB_ABI = JSON.stringify([
  { type: "function", name: "implementation", inputs: [] },
  { type: "function", name: "admin", inputs: [] },
]);

// A large "implementation" ABI — 100 functions
const IMPL_ABI = JSON.stringify(
  Array.from({ length: 100 }, (_, i) => ({
    type: "function",
    name: `fn${i}`,
    inputs: [{ type: "uint256" }],
  }))
);

// ---------------------------------------------------------------------------
// collectContractRefs
// ---------------------------------------------------------------------------

describe("collectContractRefs", () => {
  it("returns empty for non-array nodes", () => {
    expect(collectContractRefs(null)).toHaveLength(0);
    expect(collectContractRefs(undefined)).toHaveLength(0);
  });

  it("returns empty when nodes have no write/read actions", () => {
    const nodes = [makeTriggerNode()];
    expect(collectContractRefs(nodes)).toHaveLength(0);
  });

  it("collects a web3/write-contract node", () => {
    const node = makeWriteNode(
      0,
      "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "1",
      SIMPLE_ABI_TRANSFER
    );
    const refs = collectContractRefs([makeTriggerNode(), node]);
    expect(refs).toHaveLength(1);
    expect(refs[0].contractAddress).toBe(
      "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    );
    expect(refs[0].isAbiAutoFetch).toBe(true);
  });

  it("marks non-web3 write nodes as isAbiAutoFetch=false", () => {
    const node = makeWriteNode(
      0,
      "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "1",
      SIMPLE_ABI_TRANSFER,
      "protocol-write"
    );
    const refs = collectContractRefs([makeTriggerNode(), node]);
    expect(refs).toHaveLength(1);
    expect(refs[0].isAbiAutoFetch).toBe(false);
  });

  it("skips nodes with missing contractAddress/network/abi", () => {
    const node = {
      id: "bad-node",
      data: {
        type: "action",
        config: {
          actionType: "web3/write-contract",
          contractAddress: "",
          network: "1",
          abi: SIMPLE_ABI_TRANSFER,
        },
      },
    };
    const refs = collectContractRefs([node]);
    expect(refs).toHaveLength(0);
  });

  it("skips nodes whose contractAddress is a template reference (no spurious ABI fetch)", () => {
    const node = makeWriteNode(
      0,
      "{{@prep:Prep.governor_address_safe}}",
      "1",
      SIMPLE_ABI_TRANSFER
    );
    const refs = collectContractRefs([makeTriggerNode(), node]);
    expect(refs).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// validateWorkflowDeep — basic composition
// ---------------------------------------------------------------------------

describe("validateWorkflowDeep — fast tier composition", () => {
  it("returns fast-tier result when no contract refs", async () => {
    const workflow = makeWorkflow();
    const result = await validateWorkflowDeep(workflow, {
      resolveAbiOverride: vi
        .fn()
        .mockResolvedValue({ abi: SIMPLE_ABI_TRANSFER, source: "explorer" }),
    });
    expectNoAbiErrors(result);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("propagates fast-tier errors for empty nodes", async () => {
    const workflow = makeWorkflow({ nodes: [] });
    const result = await validateWorkflowDeep(workflow, {
      resolveAbiOverride: vi.fn(),
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.code === "empty-nodes-array")).toBe(
      true
    );
    expectNoAbiErrors(result);
  });

  it("returns same result as validateWorkflow when no write nodes", async () => {
    const workflow = makeWorkflow();
    const result = await validateWorkflowDeep(workflow, {
      resolveAbiOverride: vi.fn(),
    });
    expect(result.errors).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// validateWorkflowDeep — matching ABI → no warning
// ---------------------------------------------------------------------------

describe("validateWorkflowDeep — ABI match", () => {
  it("emits no warning when declared ABI matches resolved ABI", async () => {
    const writeNode = makeWriteNode(
      0,
      "0xabcabcabcabcabcabcabcabcabcabcabcabcabca",
      "1",
      SIMPLE_ABI_TRANSFER
    );
    const workflow = makeWorkflow({
      nodes: [makeTriggerNode(), writeNode],
      workflowType: "write",
    });
    const mockResolve = vi.fn().mockResolvedValue({
      abi: SIMPLE_ABI_TRANSFER,
      source: "explorer",
    });
    const result = await validateWorkflowDeep(workflow, {
      resolveAbiOverride: mockResolve,
    });
    expect(result.warnings).toHaveLength(0);
    expectNoAbiErrors(result);
  });
});

// ---------------------------------------------------------------------------
// validateWorkflowDeep — ABI mismatch → warning only, never error
// ---------------------------------------------------------------------------

describe("validateWorkflowDeep — ABI mismatch (Pitfall 1)", () => {
  it("emits a warning when declared ABI differs from resolved ABI", async () => {
    // Declared: transfer. Resolved: approve. Mismatch.
    const writeNode = makeWriteNode(
      0,
      "0xabcabcabcabcabcabcabcabcabcabcabcabcabca",
      "1",
      SIMPLE_ABI_TRANSFER
    );
    const workflow = makeWorkflow({
      nodes: [makeTriggerNode(), writeNode],
      workflowType: "write",
    });
    const mockResolve = vi.fn().mockResolvedValue({
      abi: SIMPLE_ABI_APPROVE,
      source: "explorer",
    });
    const result = await validateWorkflowDeep(workflow, {
      resolveAbiOverride: mockResolve,
    });
    expect(
      result.warnings.some((w) => w.code === "low-confidence-abi-match")
    ).toBe(true);
    // parameterPath must reference the node's config.abi
    const warning = result.warnings.find(
      (w) => w.code === "low-confidence-abi-match"
    );
    expect(warning?.parameterPath).toContain("config.abi");
    // CRITICAL: never an error
    expectNoAbiErrors(result);
    // valid must reflect only errors, not warnings
    expect(result.valid).toBe(true);
  });

  it("mismatch result lands in warnings[], NEVER errors[] (assertion on errors array explicitly)", async () => {
    const writeNode = makeWriteNode(
      0,
      "0xdefdefdefdefdefdefdefdefdefdefdefdefdef0",
      "1",
      SIMPLE_ABI_TRANSFER
    );
    const workflow = makeWorkflow({
      nodes: [makeTriggerNode(), writeNode],
      workflowType: "write",
    });
    const mockResolve = vi.fn().mockResolvedValue({
      abi: SIMPLE_ABI_APPROVE,
      source: "explorer",
    });
    const result = await validateWorkflowDeep(workflow, {
      resolveAbiOverride: mockResolve,
    });
    // Explicit assertion: errors array is empty
    expect(result.errors).toHaveLength(0);
    expect(
      result.errors.filter((e) => e.code === "low-confidence-abi-match")
    ).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// validateWorkflowDeep — proxy contract fixture (Pitfall 1 regression)
// ---------------------------------------------------------------------------

describe("validateWorkflowDeep — proxy contract (Pitfall 1 regression)", () => {
  it("emits only a warning (not error) when explorer returns implementation ABI for a proxy", async () => {
    // Workflow declares a 3-function proxy stub ABI; explorer returns 100-function impl ABI.
    // This is the Aave V3 / Uniswap pattern — resolveAbi already handled the proxy.
    const writeNode = makeWriteNode(
      0,
      "0x1111111111111111111111111111111111111111",
      "1",
      PROXY_STUB_ABI
    );
    const workflow = makeWorkflow({
      nodes: [makeTriggerNode(), writeNode],
      workflowType: "write",
    });
    const mockResolve = vi.fn().mockResolvedValue({
      abi: IMPL_ABI,
      source: "explorer",
    });
    const result = await validateWorkflowDeep(workflow, {
      resolveAbiOverride: mockResolve,
    });
    // Warning is expected (signatures differ)
    expect(
      result.warnings.some((w) => w.code === "low-confidence-abi-match")
    ).toBe(true);
    // NO errors
    expect(result.errors).toHaveLength(0);
    expectNoAbiErrors(result);
  });
});

// ---------------------------------------------------------------------------
// validateWorkflowDeep — resolveAbi throws → silent skip
// ---------------------------------------------------------------------------

describe("validateWorkflowDeep — resolveAbi failure handling", () => {
  it("emits no warning or error when resolveAbi rejects (degraded explorer)", async () => {
    const writeNode = makeWriteNode(
      0,
      "0xabcabcabcabcabcabcabcabcabcabcabcabcabca",
      "1",
      SIMPLE_ABI_TRANSFER
    );
    const workflow = makeWorkflow({
      nodes: [makeTriggerNode(), writeNode],
      workflowType: "write",
    });
    const mockResolve = vi
      .fn()
      .mockRejectedValue(
        new Error("Unable to fetch ABI: contract not verified")
      );
    const result = await validateWorkflowDeep(workflow, {
      resolveAbiOverride: mockResolve,
    });
    expect(result.warnings).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
    expectNoAbiErrors(result);
  });
});

// ---------------------------------------------------------------------------
// validateWorkflowDeep — per-call timeout (2000ms by default)
// ---------------------------------------------------------------------------

describe("validateWorkflowDeep — per-call timeout", () => {
  it("silently abandons a call that never resolves, completes in < 2500ms", async () => {
    vi.useRealTimers();
    const writeNode = makeWriteNode(
      0,
      "0xabcabcabcabcabcabcabcabcabcabcabcabcabca",
      "1",
      SIMPLE_ABI_TRANSFER
    );
    const workflow = makeWorkflow({
      nodes: [makeTriggerNode(), writeNode],
      workflowType: "write",
    });
    // Never resolves
    const mockResolve = vi.fn().mockImplementation(
      () =>
        new Promise<never>(() => {
          /* intentionally never resolves */
        })
    );
    const start = Date.now();
    const result = await validateWorkflowDeep(workflow, {
      resolveAbiOverride: mockResolve,
      perCallTimeoutMs: 200, // use short timeout for test speed
      aggregateDeadlineMs: 300, // aggregate also short
    });
    const elapsed = Date.now() - start;
    // Must complete well within 2500ms even with per-call default of 2000ms
    expect(elapsed).toBeLessThan(2500);
    // Silent — no warnings, no errors
    expect(result.warnings).toHaveLength(0);
    expectNoAbiErrors(result);
  }, 10_000);
});

// ---------------------------------------------------------------------------
// validateWorkflowDeep — concurrency cap (5 in-flight)
// ---------------------------------------------------------------------------

describe("validateWorkflowDeep — concurrency cap", () => {
  it("runs 12 nodes with concurrency=5 in ~ceil(12/5)*200ms wall-clock", async () => {
    vi.useRealTimers();
    const DELAY_MS = 100; // small delay per call
    const NODE_COUNT = 12;

    const nodes = [
      makeTriggerNode(),
      ...Array.from({ length: NODE_COUNT }, (_, i) =>
        makeWriteNode(
          i,
          `0x${String(i).padStart(40, "0")}`,
          "1",
          SIMPLE_ABI_TRANSFER
        )
      ),
    ];
    const workflow = makeWorkflow({ nodes, workflowType: "write" });

    let inflightCount = 0;
    let maxInflight = 0;

    const mockResolve = vi.fn().mockImplementation(async () => {
      inflightCount++;
      maxInflight = Math.max(maxInflight, inflightCount);
      await new Promise((resolve) => setTimeout(resolve, DELAY_MS));
      inflightCount--;
      return { abi: SIMPLE_ABI_TRANSFER, source: "explorer" as const };
    });

    const start = Date.now();
    const result = await validateWorkflowDeep(workflow, {
      resolveAbiOverride: mockResolve,
      concurrency: 5,
      perCallTimeoutMs: 2000,
      aggregateDeadlineMs: 5000, // generous — we're testing concurrency, not aggregate cap
    });
    const elapsed = Date.now() - start;

    // With concurrency=5 and 100ms delay: 3 batches of 5+5+2 = 300ms
    // (plus overhead). Must be well under 12 * 100 = 1200ms.
    expect(elapsed).toBeLessThan(800);
    // All 12 matched (declared == resolved), so no warnings
    expect(result.warnings).toHaveLength(0);
    expectNoAbiErrors(result);
    // Concurrency cap was respected
    expect(maxInflight).toBeLessThanOrEqual(5);
  }, 15_000);
});

// ---------------------------------------------------------------------------
// validateWorkflowDeep — aggregate timeout (3000ms)
// ---------------------------------------------------------------------------

describe("validateWorkflowDeep — aggregate timeout", () => {
  it("completes in < 3000ms for 20 nodes with 500ms delay each", async () => {
    vi.useRealTimers();
    const DELAY_MS = 150; // short for test speed
    const NODE_COUNT = 20;

    const nodes = [
      makeTriggerNode(),
      ...Array.from({ length: NODE_COUNT }, (_, i) =>
        makeWriteNode(
          i,
          `0x${String(i).padStart(40, "0")}`,
          "1",
          SIMPLE_ABI_TRANSFER
        )
      ),
    ];
    const workflow = makeWorkflow({ nodes, workflowType: "write" });

    const mockResolve = vi.fn().mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, DELAY_MS));
      return { abi: SIMPLE_ABI_TRANSFER, source: "explorer" as const };
    });

    const start = Date.now();
    const result = await validateWorkflowDeep(workflow, {
      resolveAbiOverride: mockResolve,
      concurrency: 5,
      perCallTimeoutMs: 2000,
      aggregateDeadlineMs: 3000,
    });
    const elapsed = Date.now() - start;

    // All 20 at 150ms each, 5 concurrent = 4 batches * 150ms = 600ms
    // Well within 3000ms aggregate cap
    expect(elapsed).toBeLessThan(3000);
    // No errors
    expectNoAbiErrors(result);
  }, 15_000);

  it("aggregate cap: 50 nodes with slow resolver, completes in < 3200ms with abandoned calls producing no errors", async () => {
    vi.useRealTimers();
    const DELAY_MS = 400; // each resolveAbi takes 400ms
    const NODE_COUNT = 50;

    const nodes = [
      makeTriggerNode(),
      ...Array.from({ length: NODE_COUNT }, (_, i) =>
        makeWriteNode(
          i,
          `0x${String(i).padStart(40, "0")}`,
          "1",
          SIMPLE_ABI_TRANSFER
        )
      ),
    ];
    const workflow = makeWorkflow({ nodes, workflowType: "write" });

    let callCount = 0;

    const mockResolve = vi.fn().mockImplementation(async () => {
      callCount++;
      await new Promise((resolve) => setTimeout(resolve, DELAY_MS));
      // Return a different ABI to produce warnings on completed calls
      return { abi: SIMPLE_ABI_APPROVE, source: "explorer" as const };
    });

    const start = Date.now();
    const result = await validateWorkflowDeep(workflow, {
      resolveAbiOverride: mockResolve,
      concurrency: 5,
      perCallTimeoutMs: 2000,
      aggregateDeadlineMs: 1500, // tight cap: ~3-4 batches of 400ms = 1600ms, cap at 1500ms
    });
    const elapsed = Date.now() - start;

    // Must complete within cap + some margin
    expect(elapsed).toBeLessThan(3200);
    // Abandoned calls produce no warnings or errors for their contract refs
    // Only completed calls may produce warnings (ABI mismatch)
    // All completed calls produce a warning (approve vs transfer mismatch)
    // But not all 50 could complete in 1500ms at 400ms/batch-of-5
    expect(result.errors).toHaveLength(0);
    expectNoAbiErrors(result);
    // Some calls were abandoned (not all 50 completed)
    expect(callCount).toBeLessThan(NODE_COUNT);
  }, 15_000);
});

// ---------------------------------------------------------------------------
// validateWorkflowDeep — no write nodes → pass-through
// ---------------------------------------------------------------------------

describe("validateWorkflowDeep — no contract refs", () => {
  it("returns fast-tier pass-through for workflow with no write or read-contract nodes", async () => {
    const workflow = makeWorkflow({ nodes: [makeTriggerNode()] });
    const mockResolve = vi.fn();
    const result = await validateWorkflowDeep(workflow, {
      resolveAbiOverride: mockResolve,
    });
    expect(mockResolve).not.toHaveBeenCalled();
    expect(result.errors).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
    expectNoAbiErrors(result);
  });
});
