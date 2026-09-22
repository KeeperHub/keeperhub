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
import { getChainName } from "@/lib/chain-utils";
import { getEncodeTransform } from "@/lib/protocol-encode-transforms";
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
// Trailing parenthetical qualifier on a skip reason's chain list, e.g. the
// "(bridged)" in "only on Base/Arbitrum (bridged)". Stripped before the list
// is split so the qualifier is prose, not a chain name.
const TRAILING_PARENTHETICAL_REGEX = /\s*\([^()]*\)\s*$/;

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
        // Encode transforms are part of the runtime encode path
        // (encodeFromConfig applies them before reshape/coerce), so the
        // synthetic layer applies them too. Without this, an input whose
        // fieldType override narrows the declared ABI type - a bytes32
        // param rendered as an address field - is handed 20 bytes for a
        // 32-byte slot and fails on a protocol that is actually correct.
        let args: unknown[] = action.inputs.map((inp) => {
          const synthetic = syntheticArg(inp);
          const transform = getEncodeTransform(
            protocol.slug,
            action.slug,
            inp.name
          );
          return transform && typeof synthetic === "string"
            ? transform(synthetic)
            : synthetic;
        });
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

describe("protocol calldata: skips that claim a contract is absent", () => {
  // A skip reason saying "<contract> contract not on <chain>" is a factual
  // claim about the registry. The fixture planner takes it on trust: a slug
  // listed in `skipped` never runs on that chain. When the contract does have
  // an address there the claim is false and the action is suppressed for no
  // reason, which is the mirror of advertising a function the chain does not
  // implement. Skips for a missing prerequisite (a balance the fork does not
  // provision) use different wording and are not checked here.
  for (const protocol of getRegisteredProtocols()) {
    for (const [chainId, chainData] of Object.entries(
      protocol.testData ?? {}
    )) {
      const claims = Object.entries(chainData.skipped ?? {}).filter((entry) =>
        entry[1].includes("not on ")
      );
      if (claims.length === 0) {
        continue;
      }
      it(`${protocol.slug} on ${chainId}: every absence claim matches the registry`, () => {
        for (const [slug, reason] of claims) {
          const action = protocol.actions.find((a) => a.slug === slug);
          expect(
            action,
            `skip "${slug}" names no registered action`
          ).toBeDefined();
          const contractKey = action?.contract ?? "";
          const address = protocol.contracts[contractKey]?.addresses?.[chainId];
          expect(
            address,
            `${protocol.slug}/${slug} is skipped as "${reason}" but ${contractKey} resolves ${address} on chain ${chainId}`
          ).toBeUndefined();
          // The chain the reason names must be the chain the block skips on.
          // Absence alone is too weak a check: "not on Arbitrum" sitting in
          // the Base block is a true sentence in the wrong place, and it
          // passes an absence-only assertion while telling the next reader
          // the action was suppressed for a chain that is not this one. The
          // "only on" describe below compares named against actual for the
          // same reason.
          const named = (reason.split("not on ").pop() ?? "")
            .replace(TRAILING_PARENTHETICAL_REGEX, "")
            .trim();
          expect(
            named,
            `${protocol.slug}/${slug} is skipped on chain ${chainId} as "${reason}", but that names ${named}, not ${getChainName(chainId)}`
          ).toBe(getChainName(chainId));
        }
      });
    }
  }
});

describe("protocol calldata: skips that name where a contract does live", () => {
  // The inverted form of the check above, and the one that actually shipped
  // wrong here: "<contract> contract only on Base/Arbitrum" against a
  // registry carrying Base alone. The "not on" check cannot see it, because
  // naming a chain the contract never had is a false claim in the opposite
  // direction. Compare the named chains against the registry as a set, so a
  // reason goes stale the moment an address is added or removed.
  for (const protocol of getRegisteredProtocols()) {
    for (const [chainId, chainData] of Object.entries(
      protocol.testData ?? {}
    )) {
      const claims = Object.entries(chainData.skipped ?? {}).filter((entry) =>
        entry[1].includes("only on ")
      );
      if (claims.length === 0) {
        continue;
      }
      it(`${protocol.slug} on ${chainId}: every "only on" claim matches the registry`, () => {
        for (const [slug, reason] of claims) {
          const action = protocol.actions.find((a) => a.slug === slug);
          expect(
            action,
            `skip "${slug}" names no registered action`
          ).toBeDefined();
          const contractKey = action?.contract ?? "";
          const addresses = protocol.contracts[contractKey]?.addresses ?? {};
          expect(
            addresses[chainId],
            `${protocol.slug}/${slug} is skipped on chain ${chainId} as "${reason}", but ${contractKey} resolves there`
          ).toBeUndefined();
          const named = (reason.split("only on ").pop() ?? "")
            // A reason may qualify the chain list with a trailing
            // parenthetical -- "only on Base/Arbitrum (bridged)" names the
            // same two chains as "only on Base/Arbitrum". Without this the
            // last chain parses as "Arbitrum (bridged)" and the failure
            // message tells the author to write a list they already wrote.
            // The invariant is unchanged: the named set must equal the set
            // the registry carries.
            .replace(TRAILING_PARENTHETICAL_REGEX, "")
            .split("/")
            .map((part) => part.trim())
            .filter((part) => part !== "")
            .sort();
          const actual = Object.keys(addresses).map(getChainName).sort();
          expect(
            named,
            `${protocol.slug}/${slug} is skipped as "${reason}" but ${contractKey} resolves on ${actual.join("/")}; the chain list after "only on" must be "${Object.keys(addresses).map(getChainName).join("/")}", optionally followed by a parenthetical`
          ).toEqual(actual);
        }
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
