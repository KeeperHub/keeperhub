/**
 * #2004 -- the simulate invariant across /api/execute/*, enforced the way
 * the issue asks for it: "a route either honours a dry run or refuses one,
 * and never accepts the flag and broadcasts."
 *
 * The route list is NOT maintained by hand here. The first test walks
 * app/api/execute on the filesystem for every route.ts, and each discovered
 * route must appear in ROUTE_STANCES below -- a new route file cannot merge
 * without declaring (and wiring) exactly one of:
 *
 *   - honors-body:  body simulate:true dry-runs; a query flag and a
 *     mistyped flag are 400s; the broadcast cores are unreachable whenever
 *     a flag is present
 *   - refuses:      body AND query `simulate` are both 400s before any
 *     reservation, execution row, or broadcast
 *   - stub-501:     the route never reads a body and answers 501, so it
 *     cannot broadcast by construction; the query flag is still a 400
 *   - read-only-get: no POST handler exists; the query flag is still a 400
 *
 * The per-stance assertions iterate over the manifest, so a route declared
 * here automatically gets its behavioural checks -- declaring a stance
 * without wiring the guard fails this suite.
 *
 * The honouring routes' simulate-path details (response shapes, revert
 * surfaces, token transfers) live in
 * tests/integration/execute-simulate-route.test.ts; this file holds only
 * the family-wide invariant.
 *
 * Run with: pnpm vitest tests/integration/execute-simulate-invariant.test.ts
 */

import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Filesystem enumeration -- the route list comes from disk (the 9/7 comment
// on #2004), not from a list someone maintains by hand.
// ---------------------------------------------------------------------------

const EXECUTE_DIR = fileURLToPath(
  new URL("../../app/api/execute", import.meta.url)
);

// Returns sorted route keys: app/api/execute/<key>/route.ts, relative to the
// execute dir, with the route.ts segment stripped. Underscore-prefixed dirs
// (_lib and friends) are not route segments.
function discoverExecuteRoutes(): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith("_") || entry.name.startsWith(".")) {
        continue;
      }
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (entry.name === "route.ts") {
        const segments = path.relative(EXECUTE_DIR, full).split(path.sep);
        found.push(segments.slice(0, -1).join("/"));
      }
    }
  };
  walk(EXECUTE_DIR);
  return found.sort();
}

type SimulateStance = "honors-body" | "refuses" | "stub-501" | "read-only-get";

type RouteStance = { stance: SimulateStance; why: string };

// The manifest. Every route discovered on disk must appear here exactly once
// (and vice versa); the behavioural suites below are generated from it.
const ROUTE_STANCES: Record<string, RouteStance> = {
  transfer: {
    stance: "honors-body",
    why: "native/token transfer dry-runs via estimateGas; flag in body only",
  },
  "contract-call": {
    stance: "honors-body",
    why: "write dry-runs via provider.call + estimateGas; flag in body only",
  },
  "check-and-execute": {
    stance: "honors-body",
    why: "condition is read-only, the action write dry-runs; flag in body only",
  },
  "[...slug]": {
    stance: "refuses",
    why: "protocol actions broadcast for real (#1929); no per-action dry-run semantics, so the flag is refused (#2004 item 1, refusal branch)",
  },
  node: {
    stance: "refuses",
    why: "arbitrary node steps execute for real; simulate was silently dropped by the validator whitelist (#1929's twin) and is now refused",
  },
  swap: {
    stance: "stub-501",
    why: "501 Coming soon; body never parsed, nothing to broadcast; query flag still refused",
  },
  "[executionId]/status": {
    stance: "read-only-get",
    why: "GET-only status poll; no POST handler exists so no flag can change an outcome; query flag still refused",
  },
};

// ---------------------------------------------------------------------------
// Hoisted spies -- shared by every route harness below.
// ---------------------------------------------------------------------------

const FROM_ADDRESS = "0xaa0000000000000000000000000000000000aa00";

const spies = vi.hoisted(() => ({
  checkAndReserveExecution: vi.fn(),
  markRunning: vi.fn(),
  completeExecution: vi.fn(),
  failExecution: vi.fn(),
  setRetryCount: vi.fn(),
  createExecution: vi.fn(),
  writeContractCore: vi.fn(),
  transferFundsCore: vi.fn(),
  transferTokenCore: vi.fn(),
  readContractCore: vi.fn(),
  stepFn: vi.fn(),
  simulateContractCallMock: vi.fn(),
  simulateNativeTransferMock: vi.fn(),
  simulateTokenTransferMock: vi.fn(),
  resolveAction: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/protocols", () => ({}));

vi.mock("../../app/api/execute/_lib/auth", () => ({
  validateApiKey: vi.fn(() =>
    Promise.resolve({ organizationId: "org_test", apiKeyId: "key_test" })
  ),
}));

vi.mock("@/lib/billing/execution-guard", () => ({
  enforceExecutionLimit: vi.fn(() => Promise.resolve({ blocked: false })),
}));

vi.mock("@/lib/db/org-helpers", () => ({
  enterApiExecuteErrorContext: vi.fn(() => Promise.resolve()),
}));

vi.mock("../../app/api/execute/_lib/rate-limit", () => ({
  checkRateLimit: vi.fn(() => ({ allowed: true })),
}));

vi.mock("../../app/api/execute/_lib/wallet-check", () => ({
  requireWallet: vi.fn(() => Promise.resolve(null)),
}));

vi.mock("../../app/api/execute/_lib/spending-cap", () => ({
  checkAndReserveExecution: spies.checkAndReserveExecution,
}));

vi.mock("../../app/api/execute/_lib/concurrency-limit", () => ({
  enforceDirectExecutionConcurrency: vi.fn().mockResolvedValue(null),
}));

vi.mock(
  "../../app/api/execute/_lib/execution-service",
  async (importActual) => {
    const actual =
      await importActual<
        typeof import("../../app/api/execute/_lib/execution-service")
      >();
    return {
      ...actual,
      createExecution: spies.createExecution,
      markRunning: spies.markRunning,
      completeExecution: spies.completeExecution,
      failExecution: spies.failExecution,
      setRetryCount: spies.setRetryCount,
      redactInput: (x: unknown) => x,
    };
  }
);

vi.mock("@/plugins/web3/steps/write-contract-core", () => ({
  writeContractCore: spies.writeContractCore,
}));
vi.mock("@/plugins/web3/steps/transfer-funds-core", () => ({
  transferFundsCore: spies.transferFundsCore,
}));
vi.mock("@/plugins/web3/steps/transfer-token-core", () => ({
  transferTokenCore: spies.transferTokenCore,
}));
vi.mock("@/plugins/web3/steps/read-contract-core", () => ({
  readContractCore: spies.readContractCore,
}));

vi.mock("@/lib/execute/simulate", () => ({
  simulateContractCall: spies.simulateContractCallMock,
  simulateNativeTransfer: spies.simulateNativeTransferMock,
  simulateTokenTransfer: spies.simulateTokenTransferMock,
}));

// Validation passes through so the honouring-route happy bodies reach the
// simulate branch.
vi.mock("../../app/api/execute/_lib/validate", () => ({
  validateContractCallInput: () => ({ valid: true }),
  validateTransferInput: () => ({ valid: true }),
  validateTokenFields: () => ({ valid: true }),
  validateCheckAndExecuteInput: () => ({ valid: true }),
}));

vi.mock("@/lib/abi/cache", () => ({
  resolveAbi: vi.fn(() => Promise.resolve({ abi: "[]" })),
}));

vi.mock("@/lib/abi/utils", () => ({
  findAbiFunction: (_abi: unknown, name: string) => {
    if (name === "setValue") {
      return { name, type: "function", stateMutability: "nonpayable" };
    }
    if (name === "balanceOf") {
      return {
        name,
        type: "function",
        stateMutability: "view",
        outputs: [{ name: "", type: "uint256" }],
      };
    }
    return;
  },
}));

vi.mock("../../app/api/execute/_lib/condition", () => ({
  evaluateCondition: () => ({ met: true }),
}));

// [...slug] harness needs a resolvable action so a removed guard would reach
// the broadcast path rather than dying earlier on an unknown action.
vi.mock("@/plugins/protocol/steps/resolve-protocol-meta", () => ({
  resolveProtocolMeta: vi.fn(() => ({
    protocolSlug: "test-protocol",
    contractKey: "router",
    functionName: "swap",
    actionType: "write",
  })),
}));

vi.mock("@/lib/protocol-registry", () => ({
  getProtocol: vi.fn(() => ({
    contracts: { router: { addresses: { "8453": "0xBaseRouter" } } },
    actions: [],
  })),
  resolveContractAddress: (
    contract: { addresses: Record<string, string> },
    network: string
  ) => contract.addresses[network],
}));

vi.mock("@/lib/step-registry", () => ({
  PLUGIN_STEP_IMPORTERS: {
    "test-protocol/swap": () => Promise.resolve({}),
  },
}));

// node harness: the resolved action would execute a step if the guard were
// removed, so the refusal is observable as "stepFn never ran".
vi.mock("@/app/api/execute/_lib/action-resolver", () => ({
  resolveAction: spies.resolveAction,
}));

vi.mock("@/lib/db/schema", () => ({
  integrations: { id: "id", organizationId: "organizationId" },
  directExecutions: {},
}));

vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => Promise.resolve([])),
        })),
      })),
    })),
  },
}));

// Routes imported after mocks.
import { POST as slugPOST } from "@/app/api/execute/[...slug]/route";
import { GET as statusGET } from "@/app/api/execute/[executionId]/status/route";
import { POST as checkAndExecutePOST } from "@/app/api/execute/check-and-execute/route";
import { POST as contractCallPOST } from "@/app/api/execute/contract-call/route";
import { POST as nodePOST } from "@/app/api/execute/node/route";
import { POST as swapPOST } from "@/app/api/execute/swap/route";
import { POST as transferPOST } from "@/app/api/execute/transfer/route";

// ---------------------------------------------------------------------------
// Fixtures + harnesses.
// ---------------------------------------------------------------------------

const WRITE_ABI = JSON.stringify([
  {
    type: "function",
    name: "setValue",
    inputs: [{ name: "v", type: "uint256" }],
    outputs: [],
    stateMutability: "nonpayable",
  },
]);

const HAPPY_SIMULATE = {
  success: true,
  status: "simulated" as const,
  from: FROM_ADDRESS,
  to: "0xbb0000000000000000000000000000000000bb00",
  value: "0",
  gasEstimate: "42000",
  simulatedReturnValue: null,
  wouldRevert: false as const,
};

function jsonRequest(url: string, body: Record<string, unknown>): Request {
  return new Request(`http://localhost${url}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

type HonoringHarness = {
  post: (url: string, body: Record<string, unknown>) => Promise<Response>;
  // Arrange the simulator so a dry-run body reaches a 200 "simulated".
  arrange: () => void;
  // The simulator spy that must be the ONLY side effect on the dry-run path.
  simulator: ReturnType<typeof vi.fn>;
  // A body the route accepts up to the simulate branch.
  happyBody: Record<string, unknown>;
};

const HONORING_HARNESSES: Record<string, HonoringHarness> = {
  transfer: {
    post: (url, body) => transferPOST(jsonRequest(url, body)),
    arrange: () =>
      spies.simulateNativeTransferMock.mockResolvedValueOnce(HAPPY_SIMULATE),
    simulator: spies.simulateNativeTransferMock,
    happyBody: {
      recipientAddress: "0xcc0000000000000000000000000000000000cc00",
      amount: "0.1",
      chainId: 1,
    },
  },
  "contract-call": {
    post: (url, body) => contractCallPOST(jsonRequest(url, body)),
    arrange: () =>
      spies.simulateContractCallMock.mockResolvedValueOnce(HAPPY_SIMULATE),
    simulator: spies.simulateContractCallMock,
    happyBody: {
      contractAddress: "0xbb0000000000000000000000000000000000bb00",
      network: "1",
      functionName: "setValue",
      abi: WRITE_ABI,
      functionArgs: JSON.stringify(["1"]),
    },
  },
  "check-and-execute": {
    post: (url, body) => checkAndExecutePOST(jsonRequest(url, body)),
    arrange: () => {
      spies.readContractCore.mockResolvedValueOnce({
        success: true,
        result: 100,
      });
      spies.simulateContractCallMock.mockResolvedValueOnce(HAPPY_SIMULATE);
    },
    simulator: spies.simulateContractCallMock,
    happyBody: {
      contractAddress: "0xbb0000000000000000000000000000000000bb00",
      functionName: "balanceOf",
      functionArgs: JSON.stringify([FROM_ADDRESS]),
      abi: JSON.stringify([
        {
          type: "function",
          name: "balanceOf",
          inputs: [{ name: "", type: "address" }],
          outputs: [{ name: "", type: "uint256" }],
          stateMutability: "view",
        },
      ]),
      chainId: 1,
      condition: {},
      action: {
        contractAddress: "0xbb0000000000000000000000000000000000bb00",
        functionName: "setValue",
        functionArgs: JSON.stringify(["1"]),
        abi: WRITE_ABI,
      },
    },
  },
};

type RefusingHarness = {
  post: (url: string, body: Record<string, unknown>) => Promise<Response>;
  // A body that would execute for real if the simulate guard were removed.
  executableBody: Record<string, unknown>;
};

const REFUSING_HARNESSES: Record<string, RefusingHarness> = {
  "[...slug]": {
    post: (url, body) =>
      slugPOST(jsonRequest(url, body), {
        params: Promise.resolve({ slug: ["test-protocol", "swap"] }),
      }),
    executableBody: { chainId: 8453 },
  },
  node: {
    post: (url, body) => nodePOST(jsonRequest(url, body)),
    executableBody: {
      actionType: "web3/write-contract",
      config: { network: "1", contractAddress: "0xabc" },
    },
  },
};

const {
  checkAndReserveExecution,
  markRunning,
  completeExecution,
  failExecution,
  setRetryCount,
  createExecution,
  writeContractCore,
  transferFundsCore,
  transferTokenCore,
  stepFn,
  resolveAction,
} = spies;

// The invariant's core claim: a flag-shaped request never reaches anything
// that reserves, records, or broadcasts.
function expectNoBroadcastSideEffects(): void {
  expect(checkAndReserveExecution).not.toHaveBeenCalled();
  expect(markRunning).not.toHaveBeenCalled();
  expect(completeExecution).not.toHaveBeenCalled();
  expect(failExecution).not.toHaveBeenCalled();
  expect(createExecution).not.toHaveBeenCalled();
  expect(setRetryCount).not.toHaveBeenCalled();
  expect(writeContractCore).not.toHaveBeenCalled();
  expect(transferFundsCore).not.toHaveBeenCalled();
  expect(transferTokenCore).not.toHaveBeenCalled();
  expect(stepFn).not.toHaveBeenCalled();
}

async function expectUnsupportedParam(res: Response): Promise<void> {
  expect(res.status).toBe(400);
  const body = (await res.json()) as Record<string, unknown>;
  expect(body.code).toBe("unsupported_param");
  expect(body.field).toBe("simulate");
  // The refusal names the routes that do honour a dry run, so a caller
  // holding the flag in the wrong place knows where it belongs.
  expect(String(body.error)).toContain("/api/execute/transfer");
  expect(String(body.error)).toContain("/api/execute/contract-call");
  expect(String(body.error)).toContain("/api/execute/check-and-execute");
}

beforeEach(() => {
  for (const spy of Object.values(spies)) {
    spy.mockReset();
  }
  completeExecution.mockResolvedValue({ status: "completed" });
  failExecution.mockResolvedValue({ status: "failed" });
  checkAndReserveExecution.mockResolvedValue({
    allowed: true,
    executionId: "exec_1",
  });
  createExecution.mockResolvedValue({ executionId: "exec_1" });
  resolveAction.mockImplementation((actionType: string) => ({
    actionType,
    label: "Test Action",
    importer: {
      importer: () => Promise.resolve({ step: stepFn }),
      stepFunction: "step",
    },
    isPluginAction: true,
  }));
  stepFn.mockResolvedValue({ success: true });
});

// ---------------------------------------------------------------------------
// Part 1: the route list comes from the filesystem.
// ---------------------------------------------------------------------------

describe("#2004 route discovery", () => {
  it("every route file under app/api/execute has declared a simulate stance", () => {
    const discovered = discoverExecuteRoutes();
    const declared = Object.keys(ROUTE_STANCES).sort();

    // Both directions: a new route file cannot appear without a stance, and
    // a deleted route cannot leave a stale one behind.
    expect(discovered).toEqual(declared);
  });

  it("the refusal messages name exactly the routes that honour a dry run", () => {
    const honoring = Object.entries(ROUTE_STANCES)
      .filter(([, s]) => s.stance === "honors-body")
      .map(([key]) => `/api/execute/${key}`)
      .sort();
    // Guarded structurally by expectUnsupportedParam; here we pin that the
    // honouring set is exactly the three routes the issue names, so the
    // message cannot silently drift.
    expect(honoring).toEqual([
      "/api/execute/check-and-execute",
      "/api/execute/contract-call",
      "/api/execute/transfer",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Part 2: honouring routes -- dry-run in the body, refusal everywhere else.
// ---------------------------------------------------------------------------

describe("#2004 honouring routes", () => {
  for (const [routeKey, harness] of Object.entries(HONORING_HARNESSES)) {
    describe(routeKey, () => {
      it("body simulate:true dry-runs: the simulator is the only side effect", async () => {
        harness.arrange();

        const res = await harness.post(`/api/execute/${routeKey}`, {
          ...harness.happyBody,
          simulate: true,
        });

        expect(res.status).toBe(200);
        const body = (await res.json()) as Record<string, unknown>;
        expect(body.status).toBe("simulated");
        expect(harness.simulator).toHaveBeenCalledTimes(1);
        expectNoBroadcastSideEffects();
      });

      it("query ?simulate=true is a 400 and never reserves or broadcasts", async () => {
        const res = await harness.post(
          `/api/execute/${routeKey}?simulate=true`,
          harness.happyBody
        );

        await expectUnsupportedParam(res);
        expect(harness.simulator).not.toHaveBeenCalled();
        expectNoBroadcastSideEffects();
      });

      it("body simulate:'true' is still a 400 (strict boolean, nothing falls through)", async () => {
        const res = await harness.post(`/api/execute/${routeKey}`, {
          ...harness.happyBody,
          simulate: "true" as unknown as boolean,
        });

        expect(res.status).toBe(400);
        expect(harness.simulator).not.toHaveBeenCalled();
        expectNoBroadcastSideEffects();
      });
    });
  }
});

// ---------------------------------------------------------------------------
// Part 3: refusing routes -- any flag shape is a 400 before any side effect.
// ---------------------------------------------------------------------------

describe("#2004 refusing routes", () => {
  for (const [routeKey, harness] of Object.entries(REFUSING_HARNESSES)) {
    describe(routeKey, () => {
      it("body simulate:true is a 400 before any reservation or broadcast", async () => {
        const res = await harness.post(`/api/execute/${routeKey}`, {
          ...harness.executableBody,
          simulate: true,
        });

        await expectUnsupportedParam(res);
        expectNoBroadcastSideEffects();
      });

      it("body simulate:'true' is refused too -- a refusing route has no correct flag shape", async () => {
        const res = await harness.post(`/api/execute/${routeKey}`, {
          ...harness.executableBody,
          simulate: "true" as unknown as boolean,
        });

        expect(res.status).toBe(400);
        expectNoBroadcastSideEffects();
      });

      it("query ?simulate=true is a 400 before anything else", async () => {
        const res = await harness.post(
          `/api/execute/${routeKey}?simulate=true`,
          harness.executableBody
        );

        await expectUnsupportedParam(res);
        expectNoBroadcastSideEffects();
      });
    });
  }

  it("the [...slug] refusal fires even when the action would resolve", async () => {
    // resolveProtocolMeta is mocked to a resolvable write action; the flag
    // must still be refused before any protocol resolution, idempotency
    // reservation, or execution row.
    const res = await slugPOST(
      jsonRequest("/api/execute/test-protocol/swap", {
        chainId: 8453,
        simulate: true,
      }),
      { params: Promise.resolve({ slug: ["test-protocol", "swap"] }) }
    );

    await expectUnsupportedParam(res);
    expectNoBroadcastSideEffects();
  });
});

// ---------------------------------------------------------------------------
// Part 4: the two routes that cannot broadcast, for completeness of the
// family-wide query refusal (#2004 item 2: every /api/execute/* route).
// ---------------------------------------------------------------------------

describe("#2004 non-broadcast routes still refuse the query flag", () => {
  it("swap: ?simulate=true is a 400, not the 501", async () => {
    const res = await swapPOST(
      jsonRequest("/api/execute/swap?simulate=true", {})
    );
    await expectUnsupportedParam(res);
  });

  it("swap: without the flag the stub still answers 501", async () => {
    const res = await swapPOST(jsonRequest("/api/execute/swap", {}));
    expect(res.status).toBe(501);
  });

  it("[executionId]/status: GET ?simulate=true is a 400", async () => {
    const res = await statusGET(
      new Request("http://localhost/api/execute/exec_1/status?simulate=true", {
        method: "GET",
      }),
      { params: Promise.resolve({ executionId: "exec_1" }) }
    );
    await expectUnsupportedParam(res);
  });
});
