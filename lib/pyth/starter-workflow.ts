import type { WorkflowData } from "@/lib/api-client";
import { parsePythTriggerConfig } from "./price-trigger";

export function createPythStarterWorkflow(input: unknown): WorkflowData {
  const config = parsePythTriggerConfig(input);
  return {
    name: "ETH / USD price trigger",
    description:
      "Native Pyth Hermes price crossing with a recorded USD result.",
    enabled: false,
    nodes: [
      {
        id: "pyth",
        type: "trigger",
        position: { x: 0, y: 0 },
        data: {
          type: "trigger",
          label: "Pyth",
          config: { ...config, triggerType: "Pyth Price" },
        },
      },
      {
        id: "scale",
        type: "action",
        position: { x: 320, y: 0 },
        data: {
          type: "action",
          label: "Scale",
          config: {
            actionType: "math/aggregate",
            operation: "sum",
            inputMode: "explicit",
            explicitValues: "10",
            postOperation: "power",
            postOperand: "{{@pyth:Pyth.exponent}}",
          },
        },
      },
      {
        id: "record-price",
        type: "action",
        position: { x: 640, y: 0 },
        data: {
          type: "action",
          label: "Record observed USD price",
          config: {
            actionType: "math/aggregate",
            operation: "sum",
            inputMode: "explicit",
            explicitValues: "{{@pyth:Pyth.price}}",
            postOperation: "multiply",
            postOperand: "{{@scale:Scale.result}}",
          },
        },
      },
    ],
    edges: [
      {
        id: "pyth-to-scale",
        source: "pyth",
        target: "scale",
        type: "animated",
      },
      {
        id: "scale-to-record",
        source: "scale",
        target: "record-price",
        type: "animated",
      },
    ],
  };
}
