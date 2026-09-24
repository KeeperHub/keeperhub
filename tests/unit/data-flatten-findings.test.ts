import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("@/lib/workflow/executor/step-handler", async () =>
  (await import("../mocks/step-mocks")).stepHandlerPassthrough()
);

vi.mock("@/lib/metrics/instrumentation/plugin", async () =>
  (await import("../mocks/step-mocks")).pluginMetricsPassthrough()
);

import {
  type FlattenFindingsCoreInput,
  type FlattenFindingsInput,
  flattenFindingsStep,
} from "@/plugins/data/steps/flatten-findings";

type FlattenSuccess = {
  success: true;
  anyFound: boolean;
  count: number;
  findings: Array<{
    label: string;
    severity: string;
    hash: string | null;
    item: unknown;
  }>;
  labels: string[];
  firstHash: string | null;
  summary: string;
  truncated: boolean;
};

type FlattenFailure = { success: false; error: string };

function makeInput(
  overrides: Partial<FlattenFindingsCoreInput>
): FlattenFindingsInput {
  return { sources: "[]", ...overrides } as FlattenFindingsInput;
}

async function run(
  overrides: Partial<FlattenFindingsCoreInput>
): Promise<FlattenSuccess | FlattenFailure> {
  return (await flattenFindingsStep(makeInput(overrides))) as
    | FlattenSuccess
    | FlattenFailure;
}

describe("data/flatten-findings", () => {
  it("flattens event and transaction results into one labelled list", async () => {
    const result = (await run({
      sources: JSON.stringify([
        {
          label: "File changed",
          value: {
            success: true,
            events: [
              { transactionHash: "0xaaa" },
              { transactionHash: "0xbbb" },
            ],
          },
        },
        {
          label: "Owner call",
          value: {
            success: true,
            transactions: [{ transactionHash: "0xccc" }],
          },
          severity: "critical",
        },
      ]),
    })) as FlattenSuccess;

    expect(result.success).toBe(true);
    expect(result.anyFound).toBe(true);
    expect(result.count).toBe(3);
    expect(result.labels).toEqual(["File changed", "Owner call"]);
    expect(result.firstHash).toBe("0xaaa");
    expect(result.findings[2].severity).toBe("critical");
  });

  it("reports nothing found when every source is empty", async () => {
    const result = (await run({
      sources: JSON.stringify([
        { label: "File changed", value: { success: true, events: [] } },
        { label: "Bounds check", value: false },
      ]),
    })) as FlattenSuccess;

    expect(result.anyFound).toBe(false);
    expect(result.count).toBe(0);
    expect(result.summary).toBe("No findings.");
    expect(result.firstHash).toBeNull();
  });

  it("treats a boolean check as a single finding", async () => {
    const result = (await run({
      sources: JSON.stringify([{ label: "Above bound", value: true }]),
    })) as FlattenSuccess;

    expect(result.count).toBe(1);
    expect(result.findings[0].item).toEqual({ triggered: true });
  });

  it("applies the default severity to sources without one", async () => {
    const result = (await run({
      sources: JSON.stringify([{ label: "Check", value: true }]),
      defaultSeverity: "info",
    })) as FlattenSuccess;

    expect(result.findings[0].severity).toBe("info");
  });

  it("reads a nested array through itemsPath", async () => {
    const result = (await run({
      sources: JSON.stringify([
        {
          label: "Nested",
          value: { data: { result: [{ id: 1 }, { id: 2 }] } },
          itemsPath: "data.result",
        },
      ]),
    })) as FlattenSuccess;

    expect(result.count).toBe(2);
  });

  it("reads the hash from a custom field", async () => {
    const result = (await run({
      sources: JSON.stringify([
        { label: "Nested", value: [{ tx: { hash: "0xdead" } }] },
      ]),
      hashField: "tx.hash",
    })) as FlattenSuccess;

    expect(result.firstHash).toBe("0xdead");
  });

  it("caps the findings list but still reports the true total", async () => {
    const result = (await run({
      sources: JSON.stringify([
        { label: "Many", value: [{ i: 1 }, { i: 2 }, { i: 3 }] },
      ]),
      maxFindings: 2,
    })) as FlattenSuccess;

    expect(result.count).toBe(3);
    expect(result.findings).toHaveLength(2);
    expect(result.truncated).toBe(true);
    expect(result.summary).toContain("3 finding(s)");
  });

  it("rejects sources that are not a JSON array", async () => {
    const result = await run({ sources: '{"label": "x"}' });

    expect(result.success).toBe(false);
    expect((result as FlattenFailure).error).toContain("JSON array");
  });
});
