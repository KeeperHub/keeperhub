import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("@/lib/workflow/executor/step-handler", async () =>
  (await import("../mocks/step-mocks")).stepHandlerPassthrough()
);

vi.mock("@/lib/metrics/instrumentation/plugin", async () =>
  (await import("../mocks/step-mocks")).pluginMetricsPassthrough()
);

import {
  type ConsensusToleranceCoreInput,
  type ConsensusToleranceInput,
  consensusToleranceStep,
} from "@/plugins/math/steps/consensus-tolerance";

type ConsensusSuccess = {
  success: true;
  inConsensus: boolean;
  sourceCount: number;
  maxDeviation: string;
  maxPercentDeviation: string;
  mode: string;
  tolerance: string;
  median: string;
  values: string[];
};

type ConsensusFailure = { success: false; error: string };

function makeInput(
  overrides: Partial<ConsensusToleranceCoreInput>
): ConsensusToleranceInput {
  return {
    values: "100\n100",
    tolerance: "1",
    ...overrides,
  } as ConsensusToleranceInput;
}

async function run(
  overrides: Partial<ConsensusToleranceCoreInput>
): Promise<ConsensusSuccess | ConsensusFailure> {
  return (await consensusToleranceStep(makeInput(overrides))) as
    | ConsensusSuccess
    | ConsensusFailure;
}

async function runOk(
  overrides: Partial<ConsensusToleranceCoreInput>
): Promise<ConsensusSuccess> {
  const result = await run(overrides);
  expect(result.success).toBe(true);
  return result as ConsensusSuccess;
}

function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1) {
    return [items];
  }
  const result: T[][] = [];
  for (const [index, item] of items.entries()) {
    const rest = [...items.slice(0, index), ...items.slice(index + 1)];
    for (const tail of permutations(rest)) {
      result.push([item, ...tail]);
    }
  }
  return result;
}

describe("math/consensus-tolerance", () => {
  it("returns the same verdict whichever order the sources arrive in", async () => {
    const forward = await runOk({ values: "100\n101", tolerance: "0.995" });
    const reversed = await runOk({ values: "101\n100", tolerance: "0.995" });

    expect(forward.inConsensus).toBe(true);
    expect(reversed.inConsensus).toBe(true);
    expect(reversed.maxPercentDeviation).toBe(forward.maxPercentDeviation);
    expect(forward.maxPercentDeviation).toBe("0.9901");
  });

  it("breaches in both orders when the pair is past the tolerance", async () => {
    const forward = await runOk({ values: "100\n101", tolerance: "0.9" });
    const reversed = await runOk({ values: "101\n100", tolerance: "0.9" });

    expect(forward.inConsensus).toBe(false);
    expect(reversed.inConsensus).toBe(false);
  });

  it("accepts a zero source in either position", async () => {
    const zeroFirst = await runOk({ values: "0\n5", tolerance: "200" });
    const zeroLast = await runOk({ values: "5\n0", tolerance: "200" });

    expect(zeroFirst.inConsensus).toBe(true);
    expect(zeroLast.inConsensus).toBe(true);
    expect(zeroLast.maxPercentDeviation).toBe(zeroFirst.maxPercentDeviation);
    expect(zeroFirst.maxPercentDeviation).toBe("100");
  });

  it("rejects a zero source in either position when the tolerance is tighter", async () => {
    const zeroFirst = await runOk({ values: "0\n5", tolerance: "50" });
    const zeroLast = await runOk({ values: "5\n0", tolerance: "50" });

    expect(zeroFirst.inConsensus).toBe(false);
    expect(zeroLast.inConsensus).toBe(false);
  });

  it("reports the same worst deviation whichever order three sources arrive in", async () => {
    const forward = await runOk({ values: "100\n110\n101", tolerance: "20" });
    const reversed = await runOk({ values: "101\n110\n100", tolerance: "20" });

    expect(forward.maxDeviation).toBe("10");
    expect(reversed.maxDeviation).toBe("10");
    expect(forward.maxPercentDeviation).toBe("9.09091");
    expect(reversed.maxPercentDeviation).toBe("9.09091");
  });

  it("reports a zero spread as zero percent, not null", async () => {
    const result = await runOk({ values: "100\n100" });

    expect(result.inConsensus).toBe(true);
    expect(result.maxDeviation).toBe("0");
    expect(result.maxPercentDeviation).toBe("0");
    expect(result.median).toBe("100");
  });

  it("refuses a single source", async () => {
    const result = await run({ values: "100" });

    expect(result.success).toBe(false);
    expect((result as ConsensusFailure).error).toBe(
      "Insufficient sources: got 1, minimum required is 2"
    );
  });

  it("refuses empty input without touching the arithmetic", async () => {
    const result = await run({ values: "", minSources: 0 });

    expect(result.success).toBe(false);
    expect((result as ConsensusFailure).error).toBe(
      "Insufficient sources: got 0, minimum required is 2"
    );
  });

  it("floors the minimum at two even when a lower value is configured", async () => {
    const result = await run({ values: "100", minSources: 1 });

    expect(result.success).toBe(false);
    expect((result as ConsensusFailure).error).toBe(
      "Insufficient sources: got 1, minimum required is 2"
    );
  });

  it("honours a minimum above the source count", async () => {
    const short = await run({ values: "100\n100\n100", minSources: 4 });
    const met = await run({ values: "100\n100\n100", minSources: 3 });

    expect(short.success).toBe(false);
    expect((short as ConsensusFailure).error).toBe(
      "Insufficient sources: got 3, minimum required is 4"
    );
    expect(met.success).toBe(true);
    expect((met as ConsensusSuccess).sourceCount).toBe(3);
  });

  it("averages the two middle values for an even count", async () => {
    const wholes = await runOk({ values: "1\n2", tolerance: "100" });
    const decimals = await runOk({
      values: "2000.50\n2001.51",
      tolerance: "100",
    });

    expect(wholes.median).toBe("1.5");
    expect(decimals.median).toBe("2001.005");
    expect(decimals.maxDeviation).toBe("1.01");
  });

  it("averages negative middle values in the same direction", async () => {
    const even = await runOk({ values: "-2\n-1", tolerance: "100" });
    const odd = await runOk({ values: "-5\n-1\n-3", tolerance: "500" });

    expect(even.median).toBe("-1.5");
    expect(odd.median).toBe("-3");
  });

  it("takes the middle value for an odd count", async () => {
    const result = await runOk({ values: "100\n110\n101", tolerance: "20" });

    expect(result.median).toBe("101");
  });

  it("compares an absolute tolerance that has more decimals than the sources", async () => {
    const outside = await runOk({
      values: "3000\n3001",
      tolerance: "0.5",
      mode: "absolute",
    });
    const within = await runOk({
      values: "3000\n3001",
      tolerance: "1.5",
      mode: "absolute",
    });

    expect(outside.success).toBe(true);
    expect(outside.inConsensus).toBe(false);
    expect(outside.maxDeviation).toBe("1");
    expect(outside.mode).toBe("absolute");
    expect(within.inConsensus).toBe(true);
  });

  it("compares an absolute tolerance that has fewer decimals than the sources", async () => {
    const within = await runOk({
      values: "3000.25\n3000.75",
      tolerance: "1",
      mode: "absolute",
    });
    const outside = await runOk({
      values: "3000.25\n3000.75",
      tolerance: "0.25",
      mode: "absolute",
    });

    expect(within.inConsensus).toBe(true);
    expect(outside.inConsensus).toBe(false);
    expect(outside.maxDeviation).toBe("0.5");
  });

  it("reads a comma inside a value as a thousands separator", async () => {
    const result = await runOk({ values: "1,234.5\n1235", tolerance: "0.1" });

    expect(result.sourceCount).toBe(2);
    expect(result.values).toEqual(["1,234.5", "1235"]);
    expect(result.inConsensus).toBe(true);
    expect(result.maxPercentDeviation).toBe("0.040486");
  });

  it("separates WAD magnitude sources that a float round-trip cannot", async () => {
    const wad = "1000000000000000000";
    const offByOne = "1000000000000000001";

    const exact = await runOk({
      values: `${wad}\n${offByOne}`,
      tolerance: "0",
    });
    const loose = await runOk({
      values: `${wad}\n${offByOne}`,
      tolerance: "0.000001",
    });

    expect(exact.inConsensus).toBe(false);
    expect(exact.maxDeviation).toBe("1");
    expect(exact.median).toBe("1000000000000000000.5");
    expect(loose.inConsensus).toBe(true);
  });

  it("reads a JSON array of sources", async () => {
    const result = await runOk({
      values: '["100", "101"]',
      tolerance: "2",
    });

    expect(result.sourceCount).toBe(2);
    expect(result.values).toEqual(["100", "101"]);
    expect(result.inConsensus).toBe(true);
  });

  it("rejects a non-numeric source", async () => {
    const result = await run({ values: "100\nnot a number" });

    expect(result.success).toBe(false);
    expect((result as ConsensusFailure).error).toContain(
      "Source 2 must be a number"
    );
  });

  it("breaks consensus on a non-adjacent pair the neighbours both clear", async () => {
    const result = await runOk({ values: "100\n105\n110", tolerance: "6" });

    expect(result.inConsensus).toBe(false);
    expect(result.maxDeviation).toBe("10");
  });

  it("counts an absolute difference exactly at the tolerance as in consensus", async () => {
    const atTolerance = await runOk({
      values: "3000\n3001",
      tolerance: "1",
      mode: "absolute",
    });
    const pastTolerance = await runOk({
      values: "3000\n3002",
      tolerance: "1",
      mode: "absolute",
    });

    expect(atTolerance.inConsensus).toBe(true);
    expect(pastTolerance.inConsensus).toBe(false);
  });

  it("reports the worst ratio, not the pair with the largest difference", async () => {
    const result = await runOk({ values: "-100\n100\n300", tolerance: "150" });

    expect(result.maxDeviation).toBe("400");
    expect(result.maxPercentDeviation).toBe("200");
    expect(result.inConsensus).toBe(false);
  });

  it("keeps the verdict and the worst ratio identical across every ordering", async () => {
    const sources = ["-100", "100", "300", "250"];
    const results = await Promise.all(
      permutations(sources).map((order) =>
        runOk({ values: order.join("\n"), tolerance: "150" })
      )
    );

    const [first] = results;
    for (const result of results) {
      expect(result.inConsensus).toBe(first.inConsensus);
      expect(result.maxDeviation).toBe(first.maxDeviation);
      expect(result.maxPercentDeviation).toBe(first.maxPercentDeviation);
    }
  });

  it("reserves a zero percent deviation for sources that agree exactly", async () => {
    const wad = await runOk({
      values: "1000000000000000000\n1000000000000000001",
      tolerance: "0",
    });
    const coarse = await runOk({
      values: "100\n101",
      tolerance: "5",
      precision: 0,
    });
    const identical = await runOk({ values: "100\n100", tolerance: "0" });

    expect(wad.inConsensus).toBe(false);
    expect(wad.maxPercentDeviation).toBe("0.000001");
    expect(coarse.maxPercentDeviation).toBe("1");
    expect(identical.maxPercentDeviation).toBe("0");
  });
});
