import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("@/lib/workflow/executor/step-handler", async () =>
  (await import("../mocks/step-mocks")).stepHandlerPassthrough()
);

vi.mock("@/lib/metrics/instrumentation/plugin", async () =>
  (await import("../mocks/step-mocks")).pluginMetricsPassthrough()
);

import {
  type ExtractFieldsCoreInput,
  type ExtractFieldsInput,
  extractFieldsStep,
} from "@/plugins/data/steps/extract-fields";

type ExtractSuccess = {
  success: true;
  fields: Record<string, unknown>;
  items: Record<string, unknown>[];
  missing: string[];
  foundCount: number;
  itemCount: number;
};

type ExtractFailure = { success: false; error: string };

const CHAINLOG = JSON.stringify({
  data: { result: { vat: "0xVAT", jug: "0xJUG" } },
});

function makeInput(
  overrides: Partial<ExtractFieldsCoreInput>
): ExtractFieldsInput {
  return { source: CHAINLOG, paths: "", ...overrides } as ExtractFieldsInput;
}

async function run(
  overrides: Partial<ExtractFieldsCoreInput>
): Promise<ExtractSuccess | ExtractFailure> {
  return (await extractFieldsStep(makeInput(overrides))) as
    | ExtractSuccess
    | ExtractFailure;
}

describe("data/extract-fields", () => {
  it("pulls named paths out of an opaque upstream blob", async () => {
    const result = (await run({
      paths: "vat = data.result.vat\njug = data.result.jug",
    })) as ExtractSuccess;

    expect(result.success).toBe(true);
    expect(result.fields).toEqual({ vat: "0xVAT", jug: "0xJUG" });
    expect(result.foundCount).toBe(2);
    expect(result.missing).toEqual([]);
  });

  it("names a bare path after its last segment", async () => {
    const result = (await run({ paths: "data.result.vat" })) as ExtractSuccess;

    expect(result.fields).toEqual({ vat: "0xVAT" });
  });

  it("returns null for a missing path instead of aborting the run", async () => {
    const result = (await run({
      paths: "vat = data.result.vat\nspot = data.result.spotter",
    })) as ExtractSuccess;

    expect(result.success).toBe(true);
    expect(result.fields.spot).toBeNull();
    expect(result.missing).toEqual(["spot"]);
    expect(result.foundCount).toBe(1);
  });

  it("can return an empty string for a missing path", async () => {
    const result = (await run({
      paths: "spot = data.result.spotter",
      onMissing: "empty",
    })) as ExtractSuccess;

    expect(result.fields.spot).toBe("");
  });

  it("fails the step when asked to", async () => {
    const result = await run({
      paths: "spot = data.result.spotter",
      onMissing: "fail",
    });

    expect(result.success).toBe(false);
    expect((result as ExtractFailure).error).toContain("was not found");
  });

  it("indexes into arrays by position", async () => {
    const result = (await run({
      source: JSON.stringify({ rows: [{ amount: "5" }, { amount: "7" }] }),
      paths: "second = rows.1.amount",
    })) as ExtractSuccess;

    expect(result.fields.second).toBe("7");
  });

  it("maps the same paths over every item in array mode", async () => {
    const result = (await run({
      source: JSON.stringify([
        { pip: { address: "0xA", price: 1 } },
        { pip: { address: "0xB", price: 2 } },
      ]),
      paths: "address = pip.address\nprice = pip.price",
      mode: "array",
    })) as ExtractSuccess;

    expect(result.itemCount).toBe(2);
    expect(result.items).toEqual([
      { address: "0xA", price: 1 },
      { address: "0xB", price: 2 },
    ]);
  });

  it("combines several upstream nodes through one JSON object source", async () => {
    const result = (await run({
      source: JSON.stringify({
        chainlog: { vat: "0xVAT" },
        setup: { network: "mainnet" },
      }),
      paths: "vat = chainlog.vat\nnetwork = setup.network",
    })) as ExtractSuccess;

    expect(result.fields).toEqual({ vat: "0xVAT", network: "mainnet" });
  });

  it("rejects a source that is not JSON", async () => {
    const result = await run({ source: "not json", paths: "vat" });

    expect(result.success).toBe(false);
    expect((result as ExtractFailure).error).toContain("not valid JSON");
  });

  it("requires at least one path", async () => {
    const result = await run({ paths: "   " });

    expect(result.success).toBe(false);
    expect((result as ExtractFailure).error).toContain("Fields is required");
  });
});
