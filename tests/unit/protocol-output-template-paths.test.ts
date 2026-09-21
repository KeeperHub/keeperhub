import { describe, expect, it } from "vitest";
import "@/protocols";
import {
  getRegisteredProtocols,
  type ProtocolAction,
  type ProtocolDefinition,
  protocolActionToPluginAction,
} from "@/lib/protocol-registry";
import { structureAbiOutputs } from "@/plugins/web3/steps/structure-abi-result";

/**
 * Every template path a protocol read suggests has to resolve against the
 * shape that read actually returns.
 *
 * The instance this was written for: an action declaring an `outputs`
 * override on a function whose ABI output is unnamed used to suggest
 * `{{steps.X.<overrideName>}}`, while the value sits at `{{steps.X.result}}`.
 * Asserting the class rather than the instance is what stops the next one:
 * the suggestions come from the ABI, and the value is built from the same
 * ABI by the same function the step calls.
 *
 * The path is resolved strictly. The executor is more forgiving -- it retries
 * a failed path under `.data` and `.result` when `result` is an object -- so a
 * failure here is not always a suggestion that reads empty at runtime. The
 * strict path is the stronger invariant and the one worth holding.
 */

type AbiOutput = { name?: string; type: string; components?: AbiOutput[] };

/** A decoded value of roughly the right shape for an ABI output type. */
function sampleValue(output: AbiOutput): unknown {
  // Tuple before array: a `tuple[]` is both, and sampling it as an empty
  // array would leave structureAbiValue's element branch unexercised.
  if (output.type.startsWith("tuple")) {
    const element = (output.components ?? []).map((c) => sampleValue(c));
    return output.type.endsWith("]") ? [element] : element;
  }
  if (output.type.endsWith("]")) {
    return [];
  }
  if (output.type === "bool") {
    return true;
  }
  if (output.type === "address") {
    return "0x0000000000000000000000000000000000000001";
  }
  if (output.type.startsWith("uint") || output.type.startsWith("int")) {
    return "1";
  }
  return "0x00";
}

/** Walk a dotted path, treating every missing hop as a failure. */
function resolves(root: unknown, path: string): boolean {
  let current = root;
  for (const segment of path.split(".")) {
    if (current === null || typeof current !== "object") {
      return false;
    }
    if (!(segment in (current as Record<string, unknown>))) {
      return false;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current !== undefined;
}

function abiOutputsOf(
  def: ProtocolDefinition,
  action: ProtocolAction
): AbiOutput[] | undefined {
  const abi = def.contracts?.[action.contract]?.abi;
  if (!abi) {
    return;
  }
  const fn = (JSON.parse(abi) as Record<string, unknown>[]).find(
    (entry) => entry.type === "function" && entry.name === action.function
  ) as { outputs?: AbiOutput[] } | undefined;
  return fn?.outputs;
}

function valuePaths(def: ProtocolDefinition, action: ProtocolAction): string[] {
  return (protocolActionToPluginAction(def, action).outputFields ?? [])
    .map((field) => field.field)
    .filter((field) => field === "result" || field.startsWith("result."));
}

function findRead(slug: string): {
  def: ProtocolDefinition;
  action: ProtocolAction;
} {
  const [protocolSlug, actionSlug] = slug.split("/");
  const def = getRegisteredProtocols().find((p) => p.slug === protocolSlug);
  const action = def?.actions.find((a) => a.slug === actionSlug);
  if (!(def && action)) {
    throw new Error(`${slug} is not a registered read`);
  }
  return { def, action };
}

const reads = getRegisteredProtocols().flatMap((def) =>
  def.actions
    .filter((action) => action.type === "read")
    .map((action) => ({ def, action }))
);

describe("protocol read output template paths", () => {
  it("finds registered reads to check", () => {
    expect(reads.length).toBeGreaterThan(0);
  });

  it("resolves an ABI and a function for every registered read", () => {
    // A read with no ABI reaches the fallback that suggests bare `result`,
    // and that is the one suggestion that can be wrong at runtime: the step
    // still resolves an ABI through resolveAbi, so `result` can come back as
    // an object. Nothing is registered that way today; this fails the day
    // something is, instead of the per-action test below quietly skipping it.
    const unresolved = reads
      .filter(({ def, action }) => abiOutputsOf(def, action) === undefined)
      .map(({ def, action }) => `${def.slug}/${action.slug}`);
    expect(unresolved).toEqual([]);
  });

  for (const { def, action } of reads) {
    it(`${def.slug}/${action.slug} suggests paths that exist in its result`, () => {
      const outputs = abiOutputsOf(def, action) ?? [];
      const result = structureAbiOutputs(
        outputs.map((output) => sampleValue(output)),
        outputs as never
      );
      const stepOutput = { success: true, result };

      const suggested = valuePaths(def, action);
      expect(suggested.length).toBeGreaterThan(0);
      for (const path of suggested) {
        expect(
          resolves(stepOutput, path),
          `${def.slug}/${action.slug}: '${path}' does not resolve`
        ).toBe(true);
      }
    });
  }
});

describe("the shapes named in review", () => {
  it("suggests result, not the override name, for a single unnamed scalar", () => {
    for (const slug of [
      "layerzero/oft-token",
      "layerzero/oft-shared-decimals",
      "layerzero/oft-approval-required",
    ]) {
      const { def, action } = findRead(slug);
      expect(valuePaths(def, action), slug).toEqual(["result"]);
      // The override still supplies the wording, which is why it exists.
      const described = (
        protocolActionToPluginAction(def, action).outputFields ?? []
      ).find((field) => field.field === "result");
      expect(described?.description, slug).toBe(action.outputs?.[0]?.label);
    }
  });

  it("keys a single named output by its ABI name", () => {
    // Named explicitly rather than found by registration order, so an edit
    // to an unrelated ABI cannot silently change what this asserts.
    const { def, action } = findRead("aerodrome/get-pool-for-pair");
    expect(abiOutputsOf(def, action)?.[0]?.name?.trim()).toBe("pool");
    // Pinned as the whole list, not sampled: bare `result` is offered too,
    // as it is on the generic Read Contract action this delegates to.
    expect(valuePaths(def, action)).toEqual(["result", "result.pool"]);
  });

  it("keys unnamed multi-outputs positionally, not by override name", () => {
    // Declares result0 -> drawnDebt over two unnamed uint256 outputs, so it
    // used to suggest `drawnDebt` while the value sits at unnamedOutput0.
    const { def, action } = findRead("aave-v4/get-user-debt");
    // The whole list, so an override name leaking back in as a path
    // (result.drawnDebt) fails here rather than slipping past a sample.
    expect(valuePaths(def, action)).toEqual([
      "result",
      "result.unnamedOutput0",
      "result.unnamedOutput1",
    ]);
  });

  it("expands a single unnamed tuple into its components", () => {
    // Its own description tells the user to type result.healthFactor; the
    // suggestion used to stop at `result`, a struct that a string field
    // renders as its JSON text rather than the component the user wanted.
    const { def, action } = findRead("aave-v4/get-user-account-data");
    expect(valuePaths(def, action)).toContain("result.healthFactor");
  });

  it("expands a named tuple output into its components", () => {
    const { def, action } = findRead("layerzero/oft-quote-send");
    expect(valuePaths(def, action)).toContain("result.fee.nativeFee");
  });
});
