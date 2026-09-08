/**
 * Tier 0 protocol registry contract tests: golden-calldata encoding.
 *
 * Two layers, both pure (no chain, no app, milliseconds):
 *
 * 1. Synthetic encode - every registered action encodes against its
 *    declared ABI with deterministic type-derived arguments. Catches a
 *    broken ABI, a renamed function, a selector change, or an input
 *    shape the encoder cannot satisfy - for all actions, including
 *    protocols that have no coverage harness yet.
 *
 * 2. Bound encode goldens - for every testData chain, every action's
 *    real bindings are resolved through buildActionWorkflow (the same
 *    builder the e2e suites use), encode transforms applied, and the
 *    exact calldata hex plus target address compared against a checked-in
 *    golden. Catches renamed inputs, binding drift, transform
 *    regressions, and contract address changes.
 *
 * Regenerate goldens after intentional changes:
 *   UPDATE_GOLDENS=1 pnpm vitest run tests/unit/protocol-calldata.test.ts
 *
 * Encoding fidelity: flattened string args go through the same
 * reshapeArgsForAbi + coerceArgsForAbi pipeline the runtime steps use
 * (lib/abi/struct-args.ts), so tuple re-nesting and type coercion match
 * production exactly.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import "@/protocols";
import { coerceArgsForAbi, reshapeArgsForAbi } from "@/lib/abi/struct-args";
import { getRegisteredProtocols } from "@/lib/protocol-registry";
import {
  encodeBoundAction,
  fragmentFor,
  ifaceFor,
} from "@/lib/test-data/encode-action";

const GOLDEN_DIR = join(
  import.meta.dirname,
  "__goldens__",
  "protocol-calldata"
);
const UPDATE = process.env.UPDATE_GOLDENS === "1";
// Fixed so goldens are stable across machines and runs.
const WALLET = "0x1111111111111111111111111111111111111111";

type GoldenEntry = { to: string; data: string; skipped: boolean };
type GoldenFile = Record<string, Record<string, GoldenEntry>>;

function syntheticArg(input: {
  type: string;
  components?: unknown[];
}): unknown {
  const t = input.type;
  if (t.endsWith("]")) {
    return [];
  }
  if (t.startsWith("tuple")) {
    const components = (input.components ?? []) as Array<{
      type: string;
      components?: unknown[];
    }>;
    return components.map((c) => syntheticArg(c));
  }
  if (t === "address") {
    return WALLET;
  }
  if (t === "bool") {
    return false;
  }
  if (t === "string") {
    return "test";
  }
  if (t.startsWith("bytes")) {
    return t === "bytes" ? "0x" : `0x${"22".repeat(Number(t.slice(5)) || 32)}`;
  }
  // uintN / intN
  return "1";
}

describe("protocol calldata: synthetic encode (all actions)", () => {
  for (const protocol of getRegisteredProtocols()) {
    for (const action of protocol.actions) {
      it(`${protocol.slug}/${action.slug} encodes against its ABI`, () => {
        const iface = ifaceFor(protocol, action);
        const { ethersFragment, abi } = fragmentFor(iface, action);
        expect(abi, `function ${action.function} not in ABI`).toBeDefined();
        let args: unknown[] = action.inputs.map((inp) => syntheticArg(inp));
        args = reshapeArgsForAbi(args, abi as never);
        args = coerceArgsForAbi(args, abi as never);
        const data = iface.encodeFunctionData(ethersFragment as never, args);
        expect(data.length).toBeGreaterThanOrEqual(10);
      });
    }
  }
});

describe("protocol calldata: registry address consistency", () => {
  for (const protocol of getRegisteredProtocols()) {
    for (const [key, contract] of Object.entries(protocol.contracts)) {
      if (contract.userSpecifiedAddress) {
        continue;
      }
      it(`${protocol.slug}/${key} has at least one chain address`, () => {
        expect(Object.keys(contract.addresses).length).toBeGreaterThan(0);
      });
    }
  }
});

describe("protocol calldata: bound-encode goldens (testData chains)", () => {
  for (const protocol of getRegisteredProtocols()) {
    const chains = Object.keys(protocol.testData ?? {});
    if (chains.length === 0) {
      continue;
    }
    const goldenPath = join(GOLDEN_DIR, `${protocol.slug}.json`);
    // Computed lazily inside it() so a single bad action fails one
    // protocol's test with its own message instead of killing collection.
    const compute = (): GoldenFile => {
      const current: GoldenFile = {};
      for (const chainId of chains) {
        current[chainId] = {};
        for (const action of protocol.actions) {
          const skipped =
            protocol.testData?.[chainId]?.skipped?.[action.slug] !== undefined;
          try {
            const { to, data } = encodeBoundAction(
              protocol,
              action,
              chainId,
              WALLET
            );
            if (!(skipped || to)) {
              // A runnable action with no target is a latent defect: a
              // userSpecifiedAddress contract with no contractAddress
              // binding (resolveContractAddress ignores the fallback map
              // for user-specified contracts).
              throw new Error(
                `${protocol.slug}/${action.slug} on ${chainId}: runnable action resolves no target address`
              );
            }
            current[chainId][action.slug] = { to, data, skipped };
          } catch (err) {
            if (skipped) {
              // A skipped action is allowed to be unencodable (its skip
              // reason documents the missing prerequisite); record that
              // state deterministically instead of failing the golden.
              current[chainId][action.slug] = {
                to: "",
                data: "unencodable-while-skipped",
                skipped: true,
              };
              continue;
            }
            throw new Error(
              `${protocol.slug}/${action.slug} on ${chainId}: ${(err as Error).message}`
            );
          }
        }
      }
      return current;
    };

    if (UPDATE) {
      it(`${protocol.slug}: goldens regenerated`, () => {
        mkdirSync(GOLDEN_DIR, { recursive: true });
        writeFileSync(goldenPath, `${JSON.stringify(compute(), null, 2)}\n`);
        expect(existsSync(goldenPath)).toBe(true);
      });
      continue;
    }

    it(`${protocol.slug}: bound calldata matches golden`, () => {
      expect(
        existsSync(goldenPath),
        `missing golden ${goldenPath}; run UPDATE_GOLDENS=1`
      ).toBe(true);
      const golden = JSON.parse(readFileSync(goldenPath, "utf8")) as GoldenFile;
      expect(compute()).toEqual(golden);
    });
  }
});
