import { describe, expect, it } from "vitest";
import type { BlockSourceOptions } from "../../src/ingest/block-source";
import { CompositeSource } from "../../src/ingest/composite-source";
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

  it("pairs signatures with a header-only getBlock when block triggers are present", () => {
    const source = createBlockSource(opts(), {
      sourceMode: "signatures",
      hasBlockTriggers: true,
    });

    expect(source).toBeInstanceOf(CompositeSource);
    const members = (source as CompositeSource).sources;
    expect(members[0]).toBeInstanceOf(SignaturesSource);
    expect(members[1]).toBeInstanceOf(GetBlockSource);
  });

  it("gives the composite's getBlock member no watched programs, so it stays header-only", () => {
    // watchedProgramIds drives GetBlockSource's detail level. Leaving them set
    // would make the block-trigger member pull full blocks - the firehose this
    // pairing exists to avoid.
    const source = createBlockSource(opts(), {
      sourceMode: "signatures",
      hasBlockTriggers: true,
    }) as CompositeSource;

    const getBlockMember = source.sources[1] as unknown as {
      opts: BlockSourceOptions;
    };
    expect(getBlockMember.opts.watchedProgramIds).toEqual([]);
  });

  it("serializes onBlock across composite members", async () => {
    // The ingestor's dedup is a check-then-set spanning two awaits, so the two
    // members must not deliver blocks concurrently.
    const order: string[] = [];
    let resolveFirst: (() => void) | undefined;
    const base = opts();
    const source = createBlockSource(
      {
        ...base,
        onBlock: (block) => {
          order.push(`start:${block.slot}`);
          if (block.slot === 1) {
            return new Promise<void>((resolve) => {
              resolveFirst = () => {
                order.push("end:1");
                resolve();
              };
            });
          }
          order.push(`end:${block.slot}`);
          return Promise.resolve();
        },
      },
      { sourceMode: "signatures", hasBlockTriggers: true },
    ) as CompositeSource;

    const members = source.sources as unknown as {
      opts: BlockSourceOptions;
    }[];
    const first = members[0].opts.onBlock({ slot: 1 } as never);
    const second = members[1].opts.onBlock({ slot: 2 } as never);

    // The second member's block must not begin while the first is in flight.
    await Promise.resolve();
    expect(order).toEqual(["start:1"]);

    resolveFirst?.();
    await Promise.all([first, second]);
    expect(order).toEqual(["start:1", "end:1", "start:2", "end:2"]);
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
