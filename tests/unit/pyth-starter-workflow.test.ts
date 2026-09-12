import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/workflow/executor/step-handler", async () =>
  (await import("../mocks/step-mocks")).stepHandlerPassthrough()
);
vi.mock("@/lib/metrics/instrumentation/plugin", async () =>
  (await import("../mocks/step-mocks")).pluginMetricsPassthrough()
);

import { pythDemoEvidence } from "@/lib/pyth/demo-evidence";
import { createPythStarterWorkflow } from "@/lib/pyth/starter-workflow";
import { type NodeOutputs, processConfigTemplates } from "@/lib/utils/template";
import {
  type AggregateInput,
  aggregateStep,
} from "@/plugins/math/steps/aggregate";
import evidence from "../fixtures/pyth-trigger/reproducible-demo-evidence.json";

const signal = evidence.executionEvidence.execution.input;
const config = {
  feedId: signal.feedId,
  direction: "above",
  threshold: "2500",
  rearmThreshold: "2490",
  maxAgeSeconds: 30,
};

describe("Pyth starter workflow", () => {
  it("keeps the public replay values consistent with the captured run", () => {
    const execution = evidence.executionEvidence.execution;
    const configuration = evidence.configuration.workflows.find(
      (workflow) => workflow.id === execution.workflow_id
    );
    expect(pythDemoEvidence).toEqual({
      executionId: execution.id,
      feedId: execution.input.feedId,
      price: execution.output.result,
      threshold: configuration?.config.threshold,
      duplicateDeliveries: evidence.redeliveryEvidence.copiesSent,
      actionCount: evidence.redeliveryEvidence.actionCount,
    });
  });
  it("requires review before activation and rejects an invalid rearm rule", () => {
    expect(createPythStarterWorkflow(config).enabled).toBe(false);
    expect(() =>
      createPythStarterWorkflow({ ...config, rearmThreshold: "2501" })
    ).toThrow("Rearm threshold");
    expect(
      createPythStarterWorkflow({
        ...config,
        direction: "below",
        rearmThreshold: "2501",
      }).nodes[0].data.config
    ).toMatchObject({ direction: "below", rearmThreshold: "2501" });
  });

  it.each([
    {
      price: signal.price,
      exponent: signal.exponent,
      expected: Number(evidence.executionEvidence.execution.output.result),
    },
    { price: "12345", exponent: -2, expected: 123.45 },
    { price: "123", exponent: 2, expected: 12_300 },
  ])(
    "converts $price with exponent $exponent through its configured Math actions",
    async ({ price, exponent, expected }) => {
      const workflow = createPythStarterWorkflow(config);
      const outputs: NodeOutputs = {
        pyth: { label: "Pyth", data: { ...signal, price, exponent } },
      };
      let result = 0;
      for (const node of workflow.nodes.slice(1)) {
        const resolved = processConfigTemplates(
          node.data.config ?? {},
          outputs
        );
        const output = (await aggregateStep(resolved as AggregateInput)) as {
          success: boolean;
          result: string;
        };
        expect(output.success).toBe(true);
        result = Number(output.result);
        outputs[node.id] = { label: node.data.label, data: output };
      }
      expect(result).toBeCloseTo(expected, 8);
    }
  );
});
