import { beforeEach, describe, expect, it, vi } from "vitest";

// Real step handler and step wrappers; the cores, which sign, are mocked so a
// call to any of them shows the step was not refused first.

vi.mock("server-only", () => ({}));
vi.mock("@/protocols", () => ({}));
vi.mock("@/lib/logging", () => ({
  ErrorCategory: {
    CONFIGURATION: "configuration",
    WORKFLOW_ENGINE: "workflow_engine",
  },
  logSystemError: vi.fn(),
  logSystemWarn: vi.fn(),
  logUserError: vi.fn(),
}));
vi.mock("@/lib/metrics/instrumentation/workflow", () => ({
  recordStepMetrics: vi.fn(),
}));
vi.mock("@/lib/metrics/instrumentation/plugin", () => ({
  withPluginMetrics: (_options: unknown, run: () => unknown) => run(),
}));
vi.mock("@/lib/workflow/executor/step-claim", () => ({
  acquireStepClaim: vi.fn(() => Promise.resolve({ outcome: "run" })),
  releaseStepClaim: vi.fn(() => Promise.resolve()),
  stepClaimScope: vi.fn((scope: unknown) => scope),
}));
vi.mock("@/lib/workflow/executor/logging", () => ({
  incrementCompletedSteps: vi.fn(),
  logStepCompleteDb: vi.fn(),
  logStepStartDb: vi.fn(),
  logWorkflowCompleteDb: vi.fn(),
  updateCurrentStep: vi.fn(),
}));

const mockPlanGate = vi.fn(() => Promise.resolve(null));
vi.mock("@/lib/features/plan-gate", () => ({
  checkActionPlanGate: (...args: unknown[]) => mockPlanGate(...(args as [])),
}));
vi.mock("@/lib/web3/explorer-link", () => ({
  resolveExplorerLink: vi.fn(() => Promise.resolve(undefined)),
}));
vi.mock("@/lib/execute/value-ledger", () => ({
  withStepValueCap: (_options: unknown, run: () => unknown) => run(),
}));

const cores = {
  writeContractCore: vi.fn(),
  batchWriteContractCore: vi.fn(),
  approveTokenCore: vi.fn(),
  transferFundsCore: vi.fn(),
  transferTokenCore: vi.fn(),
  tradeStockTokenCore: vi.fn(),
  signTypedDataCore: vi.fn(),
};
vi.mock("@/plugins/web3/steps/write-contract-core", () => ({
  applyFailOnError: (result: unknown) => result,
  writeContractCore: (...args: unknown[]) =>
    cores.writeContractCore(...(args as [])),
}));
vi.mock("@/plugins/web3/steps/batch-write-contract-core", () => ({
  applyBatchFailOnError: (result: unknown) => result,
  batchWriteContractCore: (...args: unknown[]) =>
    cores.batchWriteContractCore(...(args as [])),
}));
vi.mock("@/plugins/web3/steps/approve-token-core", () => ({
  approveTokenCore: (...args: unknown[]) =>
    cores.approveTokenCore(...(args as [])),
}));
vi.mock("@/plugins/web3/steps/transfer-funds-core", () => ({
  transferFundsCore: (...args: unknown[]) =>
    cores.transferFundsCore(...(args as [])),
}));
vi.mock("@/plugins/web3/steps/transfer-token-core", () => ({
  transferTokenCore: (...args: unknown[]) =>
    cores.transferTokenCore(...(args as [])),
}));
vi.mock("@/plugins/robinhood/steps/trade-stock-token-core", () => ({
  tradeStockTokenCore: (...args: unknown[]) =>
    cores.tradeStockTokenCore(...(args as [])),
}));
vi.mock("@/plugins/web3/steps/sign-typed-data-core", () => ({
  signTypedDataCore: (...args: unknown[]) =>
    cores.signTypedDataCore(...(args as [])),
}));

import { ExecutionErrorType } from "@/lib/errors/execution-error-type";
import {
  SENDER_NOT_CHOSEN,
  SENDER_NOT_CHOSEN_MESSAGE,
  SenderNotChosenError,
  web3ConnectionFailure,
} from "@/lib/safe/sender-not-chosen";
import {
  logStepCompleteDb,
  logStepStartDb,
} from "@/lib/workflow/executor/logging";
import { withStepLogging } from "@/lib/workflow/executor/step-handler";
import { tradeStockTokenStep } from "@/plugins/robinhood/steps/trade-stock-token";
import { approveTokenStep } from "@/plugins/web3/steps/approve-token";
import { batchWriteContractStep } from "@/plugins/web3/steps/batch-write-contract";
import { signTypedDataStep } from "@/plugins/web3/steps/sign-typed-data";
import { transferFundsStep } from "@/plugins/web3/steps/transfer-funds";
import { transferTokenStep } from "@/plugins/web3/steps/transfer-token";
import { writeContractStep } from "@/plugins/web3/steps/write-contract";

function input(actionType: string, web3Connection: string, network = "1") {
  return {
    actionType,
    network,
    web3Connection,
    _actionType: actionType,
    _context: {
      executionId: "exec-1",
      nodeId: "node-1",
      nodeName: "Copied step",
      nodeType: actionType,
      organizationId: "org-1",
    },
  };
}

type AnyStep = (stepInput: never) => Promise<unknown>;

const SIGNING_STEPS: [string, AnyStep, keyof typeof cores][] = [
  ["web3/write-contract", writeContractStep, "writeContractCore"],
  [
    "web3/batch-write-contract",
    batchWriteContractStep,
    "batchWriteContractCore",
  ],
  ["web3/approve-token", approveTokenStep, "approveTokenCore"],
  ["web3/transfer-funds", transferFundsStep, "transferFundsCore"],
  ["web3/transfer-token", transferTokenStep, "transferTokenCore"],
  ["robinhood/trade-stock-token", tradeStockTokenStep, "tradeStockTokenCore"],
];

const refused = {
  success: false,
  error: SENDER_NOT_CHOSEN_MESSAGE,
  errorClass: ExecutionErrorType.USER,
};

describe("a step with no sender is refused before it signs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(logStepStartDb).mockResolvedValue({
      logId: "log-1",
      startTime: Date.now(),
    });
    for (const core of Object.values(cores)) {
      core.mockResolvedValue({ success: true, transactionHash: "0xabc" });
    }
  });

  it.each(SIGNING_STEPS)("%s", async (actionType, step, core) => {
    const result = await step(input(actionType, SENDER_NOT_CHOSEN) as never);

    expect(result).toEqual(refused);
    expect(cores[core]).not.toHaveBeenCalled();
    // Logged as the step's failure, so the run shows which step it was.
    const persisted = vi.mocked(logStepCompleteDb).mock.calls[0][0];
    expect(persisted.status).toBe("error");
  });

  it("runs a step whose sender is picked", async () => {
    const result = await writeContractStep(
      input("web3/write-contract", "eoa") as never
    );

    expect(cores.writeContractCore).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ success: true });
  });

  it("runs a step that never reads its sender, with the mark", async () => {
    await signTypedDataStep(
      input("web3/sign-typed-data", SENDER_NOT_CHOSEN) as never
    );
    // Transfer Native Token on Solana sends from the Solana wallet.
    await transferFundsStep(
      input("web3/transfer-funds", SENDER_NOT_CHOSEN, "101") as never
    );

    expect(cores.signTypedDataCore).toHaveBeenCalledTimes(1);
    expect(cores.transferFundsCore).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["aave-v3/supply", "1"],
    ["Transfer Funds", "101"],
  ])(
    "does not refuse %s on network %s at the step handler",
    async (actionType, network) => {
      const body = vi.fn(() => Promise.resolve({ success: true }));

      await withStepLogging(
        input(actionType, SENDER_NOT_CHOSEN, network),
        body
      );

      expect(body).toHaveBeenCalledTimes(1);
      expect(mockPlanGate).toHaveBeenCalledTimes(1);
    }
  );

  it("refuses at the step handler, before the plan gate or the step body", async () => {
    const body = vi.fn(() => Promise.resolve({ success: true }));

    const result = await withStepLogging(
      input("web3/transfer-funds", SENDER_NOT_CHOSEN),
      body
    );

    expect(result).toEqual(refused);
    expect(body).not.toHaveBeenCalled();
    expect(mockPlanGate).not.toHaveBeenCalled();
  });
});

describe("web3ConnectionFailure", () => {
  it("makes a missing sender the author's to fix", () => {
    expect(web3ConnectionFailure(new SenderNotChosenError())).toEqual(refused);
  });

  it("leaves the other resolver failures to the classifier, as before", () => {
    expect(web3ConnectionFailure(new Error("Safe is not deployed"))).toEqual({
      success: false,
      error: "Failed to resolve Web3 Connection: Safe is not deployed",
    });
  });

  it("gives the other failures the caller's class when asked", () => {
    const classOf = vi.fn(() => ExecutionErrorType.SYSTEM);
    expect(web3ConnectionFailure(new Error("db down"), classOf)).toEqual({
      success: false,
      error: "Failed to resolve Web3 Connection: db down",
      errorClass: ExecutionErrorType.SYSTEM,
    });
    expect(classOf).toHaveBeenCalledWith(
      "Failed to resolve Web3 Connection: db down"
    );
    // A missing sender is USER whatever the caller's class.
    expect(web3ConnectionFailure(new SenderNotChosenError(), classOf)).toEqual(
      refused
    );
  });
});
