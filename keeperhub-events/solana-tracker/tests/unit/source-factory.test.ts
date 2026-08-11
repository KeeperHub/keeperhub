import { describe, expect, it } from "vitest";
import type { BlockSourceOptions } from "../../src/ingest/block-source";
import { GetBlockSource } from "../../src/ingest/getblock-source";
import { GeyserSource } from "../../src/ingest/geyser-source";
import { SignaturesSource } from "../../src/ingest/signatures-source";
import { createBlockSource } from "../../src/ingest/source-factory";

function opts(): BlockSourceOptions {
  return {
    chainId: 101,
    endpoints: [{ rpcUrl: "https://rpc", wssUrl: "wss://ws" }],
    commitment: "confirmed",
    watchedProgramIds: ["So11111111111111111111111111111111111111112"],
    onBlock: () => Promise.resolve(),
  };
}

describe("createBlockSource selection", () => {
  it("defaults to getBlock when no strategy is selected", () => {
    expect(createBlockSource(opts())).toBeInstanceOf(GetBlockSource);
  });

  it("uses SignaturesSource for signatures mode without block triggers", () => {
    expect(
      createBlockSource(opts(), { sourceMode: "signatures" }),
    ).toBeInstanceOf(SignaturesSource);
  });

  it("falls back to getBlock when signatures mode meets block triggers", () => {
    expect(
      createBlockSource(opts(), {
        sourceMode: "signatures",
        hasBlockTriggers: true,
      }),
    ).toBeInstanceOf(GetBlockSource);
  });

  it("uses Geyser whenever an endpoint is configured, overriding sourceMode", () => {
    expect(
      createBlockSource(opts(), {
        geyser: { endpoint: "grpc://geyser" },
        sourceMode: "signatures",
        hasBlockTriggers: true,
      }),
    ).toBeInstanceOf(GeyserSource);
  });
});
