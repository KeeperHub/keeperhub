import { describe, expect, it } from "vitest";
import "@/protocols";
import {
  getRegisteredProtocols,
  type ProtocolAction,
  type ProtocolDefinition,
  protocolActionToPluginAction,
} from "@/lib/protocol-registry";
import { processTemplate } from "@/lib/utils/template";
import { createTracker } from "@/lib/workflow/executor/template-resolution";
import {
  type AbiOutputParam,
  structureAbiOutputs,
} from "@/plugins/web3/steps/structure-abi-result";

/**
 * Every template path a protocol read suggests has to resolve against the
 * shape that read actually returns, and has to carry the protocol's own
 * wording for the value sitting there.
 *
 * The instance this was written for: an action declaring an `outputs`
 * override on a function whose ABI output is unnamed used to suggest
 * `{{steps.X.<overrideName>}}`, while the value sits at `{{steps.X.result}}`.
 * Asserting the class rather than the instance is what stops the next one:
 * the suggestions come from the ABI, and the value is built from the same
 * ABI by the same function the step calls.
 *
 * The label sweep at the bottom is the other half. A path can resolve and
 * still be useless to read: the curated label is the only thing that says
 * which of six uint256s is the health factor. It does not re-derive where a
 * value lands either - it asks `structureAbiOutputs`, by probe.
 *
 * The path is resolved by handing it to `processTemplate`, so the rules are
 * the executor's and not a restatement of them. That resolver is more
 * forgiving in one direction and stricter in another than a naive walk: it
 * maps a field access over an array cursor, and it aborts on `null` as well
 * as `undefined`. It is also stricter than the executor's own retry, which
 * tries a failed path again under `.data` and `.result`, so a failure here is
 * not always a suggestion that reads empty at runtime. The strict path is the
 * stronger invariant and the one worth holding.
 */

/** A decoded value of roughly the right shape for an ABI output type. */
function sampleValue(output: AbiOutputParam): unknown {
  const type = output.type ?? "";
  // Tuple before array: a `tuple[]` is both, and sampling it as an empty
  // array would leave structureAbiValue's element branch unexercised.
  if (type.startsWith("tuple")) {
    const element = (output.components ?? []).map((c) => sampleValue(c));
    return type.endsWith("]") ? [element] : element;
  }
  if (type.endsWith("]")) {
    return [];
  }
  if (type === "bool") {
    return true;
  }
  if (type === "address") {
    return "0x0000000000000000000000000000000000000001";
  }
  if (type.startsWith("uint") || type.startsWith("int")) {
    return "1";
  }
  return "0x00";
}

/**
 * Walk a dotted path the way a saved workflow binding does.
 *
 * Asked of `processTemplate` rather than walked here, because the rules are
 * not the ones a local walk reaches for: `resolveExpressionById` aborts on
 * `undefined` *or* `null` at every hop, and a field access on an array cursor
 * maps over the elements instead of missing. A copy of those rules is a copy
 * that can drift from them, which is the same fault one layer down that this
 * file exists to catch.
 *
 * The tracker carries the answer, not the return value: a resolved value and
 * an absent one both come back as a string, so the rendered text cannot tell
 * the two apart.
 */
function resolves(stepOutput: unknown, path: string): boolean {
  const tracker = createTracker();
  processTemplate(
    `{{$step.${path}}}`,
    { step: { label: "Step", data: stepOutput } },
    tracker
  );
  return tracker.unresolved.length === 0;
}

function abiOutputsOf(
  def: ProtocolDefinition,
  action: ProtocolAction
): AbiOutputParam[] | undefined {
  const abi = def.contracts?.[action.contract]?.abi;
  if (!abi) {
    return;
  }
  const fn = (JSON.parse(abi) as Record<string, unknown>[]).find(
    (entry) => entry.type === "function" && entry.name === action.function
  ) as { outputs?: AbiOutputParam[] } | undefined;
  return fn?.outputs;
}

function valuePaths(def: ProtocolDefinition, action: ProtocolAction): string[] {
  return (protocolActionToPluginAction(def, action).outputFields ?? [])
    .map((field) => field.field)
    .filter((field) => field === "result" || field.startsWith("result."));
}

/** The description advertised alongside each field path. */
function descriptionByPath(
  def: ProtocolDefinition,
  action: ProtocolAction
): Map<string, string> {
  return new Map(
    (protocolActionToPluginAction(def, action).outputFields ?? []).map(
      (field) => [field.field, field.description]
    )
  );
}

/**
 * Where does the whole of ABI output i end up in the runtime result?
 *
 * Asked of `structureAbiOutputs` rather than answered here, by handing it one
 * unique sentinel per output and reading back which key the sentinel landed
 * under. A sentinel is a plain string, so `structureAbiValue` passes it through
 * untouched whatever the declared type, which leaves it sitting at exactly the
 * key the runtime would use for that output. A single unnamed output lands at
 * the root, which is the bare `result`.
 *
 * Re-deriving the path here instead would only restate the implementation's own
 * ladder, and a ladder that is wrong in both places passes. Returns undefined
 * for an output that has no addressable home at all, such as one whose name
 * collides with a later output's.
 */
function runtimePathByOutputIndex(
  outputs: AbiOutputParam[]
): Array<string | undefined> {
  const sentinels = outputs.map((_, index) => `<probe:${index}>`);
  const structured = structureAbiOutputs(sentinels, outputs);
  return sentinels.map((sentinel) => {
    if (structured === sentinel) {
      return "result";
    }
    if (
      typeof structured !== "object" ||
      structured === null ||
      Array.isArray(structured)
    ) {
      return undefined;
    }
    const hit = Object.entries(structured as Record<string, unknown>).find(
      ([, value]) => value === sentinel
    );
    return hit ? `result.${hit[0]}` : undefined;
  });
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

const writes = getRegisteredProtocols().flatMap((def) =>
  def.actions
    .filter((action) => action.type === "write")
    .map((action) => ({ def, action }))
);

// Every curated label the registered reads declare, counted from the registry
// rather than written down as a number. The label sweep has to match all of
// them; anything stricter than "some exist" couples the test to the size of
// the protocol catalog.
const curatedLabelCount = reads.reduce(
  (total, { action }) => total + (action.outputs?.length ?? 0),
  0
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
        outputs
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
    expect(descriptionByPath(def, action).get("result.pool")).toBe(
      "Pool Address"
    );
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
    // The override name is gone from the path; the wording it carries is not.
    // Both names are authored as `result0`/`result1` and neither has ever been
    // a runtime key, so position is the only thing that can join them.
    const described = descriptionByPath(def, action);
    expect(described.get("result.unnamedOutput0")).toBe(
      "Drawn Debt (underlying)"
    );
    expect(described.get("result.unnamedOutput1")).toBe(
      "Premium Debt (underlying)"
    );
  });

  it("keys a named multi-output view by each ABI name", () => {
    // Six named uint256 outputs, so the labels are the only thing telling
    // them apart: a generic "Return value: uint256 (BigInt)" on all six is
    // the regression this pins.
    const { def, action } = findRead("aave-v3/get-user-account-data");
    const described = descriptionByPath(def, action);
    expect(described.get("result.healthFactor")).toBe("Health Factor");
    expect(described.get("result.currentLiquidationThreshold")).toBe(
      "Liquidation Threshold (basis points)"
    );
    expect(described.get("result.ltv")).toBe("Loan-to-Value (basis points)");
  });

  it("expands a single unnamed tuple into its components", () => {
    // Its own description tells the user to type result.healthFactor; the
    // suggestion used to stop at `result`, a struct that a string field
    // renders as its JSON text rather than the component the user wanted.
    const { def, action } = findRead("aave-v4/get-user-account-data");
    expect(valuePaths(def, action)).toContain("result.healthFactor");
    expect(valuePaths(def, action)).toContain("result.totalCollateralValue");
  });

  it("expands a named tuple output into its components", () => {
    const { def, action } = findRead("layerzero/oft-quote-send");
    expect(valuePaths(def, action)).toContain("result.fee.nativeFee");
    expect(valuePaths(def, action)).toContain("result.fee.lzTokenFee");
    // The curated label describes the whole struct, so it lands on the tuple
    // itself; the components underneath it are described generically.
    expect(descriptionByPath(def, action).get("result.fee")).toBe(
      "Messaging Fee (nativeFee, lzTokenFee, each in its token's smallest unit)"
    );
  });
});

describe("curated output labels", () => {
  it("puts every curated label on the path the runtime actually uses", () => {
    const problems: string[] = [];
    let curatedHits = 0;

    for (const { def, action } of reads) {
      const outputs = abiOutputsOf(def, action) ?? [];
      const declared = action.outputs ?? [];
      const id = `${def.slug}/${action.slug}`;

      // The positional join is only sound while the two lists line up, so pin
      // that rather than assume it.
      if (declared.length !== outputs.length) {
        problems.push(
          `${id}: action.outputs has ${declared.length} entries for ${outputs.length} ABI outputs`
        );
        continue;
      }

      const described = descriptionByPath(def, action);
      const paths = runtimePathByOutputIndex(outputs);

      for (const [index, output] of declared.entries()) {
        const { label } = output;
        const path = paths[index];
        if (!path) {
          problems.push(
            `${id}: ABI output ${index} has no reachable runtime path, so "${label}" has nowhere to land`
          );
          continue;
        }
        // A label whose path is not advertised is a failure, not something to
        // skip. Skipping it is how a label silently stops being advertised at
        // all, which is the same defect as advertising the wrong path.
        if (!described.has(path)) {
          problems.push(
            `${id}: "${path}" holds this output at runtime and carries "${label}", but no such field is advertised`
          );
          continue;
        }
        if (described.get(path) === label) {
          curatedHits++;
          continue;
        }
        problems.push(
          `${id} ${path}: advertised "${described.get(path)}", curated label is "${label}"`
        );
      }
    }

    expect(problems).toEqual([]);
    // A sweep that matched nothing would pass vacuously.
    expect(curatedLabelCount).toBeGreaterThan(0);
    // Every curated label the registry declares, matched. Counted from the
    // reads rather than pinned to a number, so an action the sweep skipped
    // entirely - or one whose `action.outputs` went missing - comes up short
    // here without the count tracking the size of the catalog.
    expect(curatedHits).toBe(curatedLabelCount);
  });
});

describe("write action output fields", () => {
  it("advertises no result paths", () => {
    // writeContractCore returns result: undefined, so a result path here
    // would be a template suggestion that never resolves. Sits next to the
    // read sweep because it is the same advertisement, gated the other way in
    // buildOutputFieldsFromAction.
    const offenders = writes.flatMap(({ def, action }) =>
      valuePaths(def, action).map(
        (path) => `${def.slug}/${action.slug}: ${path}`
      )
    );
    expect(offenders).toEqual([]);
    // A sweep that matched nothing would pass vacuously.
    expect(writes.length).toBeGreaterThan(0);
  });
});
