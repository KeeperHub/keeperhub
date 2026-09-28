import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("@/lib/workflow/executor/step-handler", async () =>
  (await import("../mocks/step-mocks")).stepHandlerPassthrough()
);

vi.mock("@/lib/metrics/instrumentation/plugin", async () =>
  (await import("../mocks/step-mocks")).pluginMetricsPassthrough()
);

import {
  type StaticConfigInput,
  staticConfigStep,
} from "@/plugins/data/steps/static-config";

type StaticSuccess = {
  success: true;
  result: unknown;
  keys: string[];
  count: number;
  valueType: string;
};

type StaticFailure = { success: false; error: string };

async function run(value: string): Promise<StaticSuccess | StaticFailure> {
  return (await staticConfigStep({ value } as StaticConfigInput)) as
    | StaticSuccess
    | StaticFailure;
}

describe("data/static-config", () => {
  it("hands an object through with its top-level keys", async () => {
    const result = (await run(
      '{"vat": "0xVAT", "jug": "0xJUG"}'
    )) as StaticSuccess;

    expect(result.success).toBe(true);
    expect(result.result).toEqual({ vat: "0xVAT", jug: "0xJUG" });
    expect(result.keys).toEqual(["vat", "jug"]);
    expect(result.count).toBe(2);
    expect(result.valueType).toBe("object");
  });

  it("counts array entries", async () => {
    const result = (await run(
      '[{"address": "0xA", "name": "one"}, {"address": "0xB", "name": "two"}]'
    )) as StaticSuccess;

    expect(result.valueType).toBe("array");
    expect(result.count).toBe(2);
    expect(result.keys).toEqual([]);
  });

  it("accepts a bare primitive", async () => {
    const result = (await run('"mainnet"')) as StaticSuccess;

    expect(result.valueType).toBe("primitive");
    expect(result.result).toBe("mainnet");
  });

  it("reports invalid JSON instead of throwing", async () => {
    const result = await run("{ not json }");

    expect(result.success).toBe(false);
    expect((result as StaticFailure).error).toContain("not valid JSON");
  });

  it("requires a value", async () => {
    const result = await run("   ");

    expect(result.success).toBe(false);
    expect((result as StaticFailure).error).toContain("required");
  });
});
