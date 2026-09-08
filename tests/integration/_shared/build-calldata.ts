/**
 * Shared calldata builder for protocol on-chain integration tests.
 *
 * Validating wrapper around the shared encode kernel in
 * lib/test-data/encode-action.ts (encodeFromConfig), which owns the
 * production pipeline: encode transforms, fragment resolution (overload
 * and flattened-tuple arity handling), reshapeArgsForAbi,
 * coerceArgsForAbi, and Interface encoding. On top of the kernel this
 * wrapper keeps the test-facing contract:
 *
 *   - rejects sampleInputs keys the action does not declare, so a typo
 *     in a test fixture fails loudly instead of encoding a default;
 *   - honors `toOverride` unconditionally and throws when no address
 *     resolves (the kernel resolves "" instead of throwing);
 *   - keeps its own error messages for unknown action / missing ABI /
 *     missing function, which tests/unit/build-calldata.test.ts pins;
 *   - offers the `coerceArgs: false` escape hatch reproducing the
 *     pre-coerce encoding (reshape only) so regression tests can pin
 *     the trap the default pipeline disarms.
 *
 * `chainId` is required so the helper cannot silently pick a wrong
 * chain when a protocol is deployed on multiple. Per-protocol assertion
 * patterns stay in their own test files; this module deliberately
 * handles only the calldata-encoding half of the test setup.
 */

import { reshapeArgsForAbi } from "@/lib/abi/struct-args";
import type {
  ProtocolAction,
  ProtocolContract,
  ProtocolDefinition,
} from "@/lib/protocol-registry";
import {
  encodeFromConfig,
  fragmentFor,
  ifaceFor,
} from "@/lib/test-data/encode-action";

type AbiEntry = {
  type: string;
  name?: string;
};

export type Calldata = {
  to: string;
  data: string;
  action: ProtocolAction;
  contract: ProtocolContract;
};

export type BuildCalldataParams = {
  /** The protocol definition the action belongs to. */
  protocol: ProtocolDefinition;
  /** Slug of the action to encode, as declared on `protocol.actions[i].slug`. */
  actionSlug: string;
  /** Map of input name to stringly-typed value. Must not contain keys
   *  that the action does not declare; unknown keys throw. Missing
   *  declared keys (and explicitly empty values) fall back to
   *  `inp.default ?? ""` on both encoding paths. */
  sampleInputs: Record<string, string>;
  /** Chain ID string as it appears in `protocol.contracts[key].addresses`.
   *  Required; mistakes here are silent bugs (wrong contract on wrong
   *  chain) so the helper does not default. */
  chainId: string;
  /** Override the resolved contract address. Use for contracts marked
   *  `userSpecifiedAddress` where the address is supplied per call rather
   *  than from the protocol definition. */
  toOverride?: string;
  /**
   * Run `coerceArgsForAbi` after `reshapeArgsForAbi`, matching the
   * production write path in `plugins/web3/steps/write-contract-core.ts`
   * (reshape -> coerce -> encode). Required for protocols whose sample
   * inputs include stringly-typed booleans (`"true"`, `"false"`), since
   * `ethers.encodeFunctionData` treats any non-empty string as truthy and
   * silently encodes `"false"` as `true` without coercion.
   *
   * Defaults to `true` so tests match the production encoding pipeline
   * by default. Pass `false` to skip `coerceArgsForAbi` and the
   * registered encode transforms (reshape only), reproducing the raw
   * pre-coerce encoding (e.g. for a regression test asserting the trap
   * exists).
   */
  coerceArgs?: boolean;
};

export function buildCalldata(params: BuildCalldataParams): Calldata {
  const {
    protocol,
    actionSlug,
    sampleInputs,
    chainId,
    toOverride,
    coerceArgs,
  } = params;

  const action = protocol.actions.find((a) => a.slug === actionSlug);
  if (!action) {
    throw new Error(`Action ${actionSlug} not found`);
  }

  const declaredInputNames = new Set(action.inputs.map((i) => i.name));
  for (const key of Object.keys(sampleInputs)) {
    if (!declaredInputNames.has(key)) {
      const known =
        action.inputs.length === 0
          ? "(none)"
          : action.inputs.map((i) => i.name).join(", ");
      throw new Error(
        `Sample input '${key}' is not declared for action '${action.slug}'. Known inputs: ${known}`
      );
    }
  }

  const contract = protocol.contracts[action.contract];
  if (!contract.abi) {
    throw new Error(`Contract ${action.contract} has no ABI`);
  }

  const to = toOverride ?? contract.addresses[chainId];
  if (!to) {
    throw new Error(
      `No address for contract ${action.contract} on chain ${chainId} and no toOverride given`
    );
  }

  const parsedAbi = JSON.parse(contract.abi) as AbiEntry[];
  const hasFunction = parsedAbi.some(
    (f) => f.type === "function" && f.name === action.function
  );
  if (!hasFunction) {
    throw new Error(
      `Function ${action.function} not found in ABI for contract ${action.contract}`
    );
  }

  if (coerceArgs === false) {
    // Escape hatch: same fragment resolution as the kernel, but skip
    // coerceArgsForAbi (and encode transforms) to reproduce the raw
    // pre-coerce encoding the regression tests assert on.
    const iface = ifaceFor(protocol, action);
    const { ethersFragment, abi } = fragmentFor(iface, action);
    const rawArgs: unknown[] = action.inputs.map((inp) => {
      const raw = sampleInputs[inp.name];
      return raw === undefined || raw === "" ? (inp.default ?? "") : raw;
    });
    const args = reshapeArgsForAbi(rawArgs, abi);
    const data = iface.encodeFunctionData(ethersFragment as never, args);
    return { to, data, action, contract };
  }

  const { data } = encodeFromConfig(protocol, action, chainId, sampleInputs);
  return { to, data, action, contract };
}
