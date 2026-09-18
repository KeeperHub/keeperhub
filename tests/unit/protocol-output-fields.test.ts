import { describe, expect, it } from "vitest";
import type {
  ProtocolAction,
  ProtocolDefinition,
} from "@/lib/protocol-registry";
import {
  getRegisteredProtocols,
  protocolActionToPluginAction,
} from "@/lib/protocol-registry";
import {
  type AbiOutputParam,
  structureAbiOutputs,
} from "@/plugins/web3/steps/structure-abi-result";
import "@/protocols";

/**
 * These tests assert the advertised paths and their descriptions against
 * `structureAbiOutputs`, the function that actually shapes a read result at
 * runtime, rather than against a second copy of the same derivation. A copy can
 * only fail when the two disagree, so a logic error present in both would pass.
 *
 * Nothing here rebuilds the implementation's named / unnamed / tuple / `> 1`
 * ladder. Reachability is checked by resolving each advertised path in a real
 * structured result, and the path a curated label belongs on is read back out
 * of `structureAbiOutputs` by probing it, never recomputed.
 *
 * Every sweep counts what it covered and asserts the count, so a case that
 * stops matching any registered protocol fails instead of passing on nothing.
 */

type AbiFunction = {
  type?: string;
  name?: string;
  outputs?: AbiOutputParam[];
};

function readAbiFunction(
  protocol: ProtocolDefinition,
  action: ProtocolAction
): AbiFunction | undefined {
  const abi = protocol.contracts[action.contract]?.abi;
  if (!(abi && action.function)) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(abi);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed)) {
    return undefined;
  }
  return (parsed as AbiFunction[]).find(
    (entry) => entry.type === "function" && entry.name === action.function
  );
}

// A stand-in decoded value per ABI param, shaped the way ethers hands one to
// structureAbiOutputs: BigInts already stringified, tuples positional arrays.
function sampleValue(param: AbiOutputParam): unknown {
  const type = param.type ?? "";
  if (type.startsWith("tuple")) {
    const components = param.components ?? [];
    const element = components.map((c) => sampleValue(c));
    return type.endsWith("]") ? [element] : element;
  }
  if (type.endsWith("]")) {
    return [];
  }
  if (type === "bool") {
    return false;
  }
  if (type === "address") {
    return "0x0000000000000000000000000000000000000000";
  }
  return "1";
}

// Walks a dotted path the way a workflow template binding does.
function resolvePath(root: unknown, path: string): { found: boolean } {
  const segments = path.split(".");
  let cursor: unknown = root;
  for (const segment of segments.slice(1)) {
    if (
      typeof cursor !== "object" ||
      cursor === null ||
      Array.isArray(cursor)
    ) {
      return { found: false };
    }
    if (!(segment in (cursor as Record<string, unknown>))) {
      return { found: false };
    }
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return { found: true };
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

function eachReadAction(
  visit: (
    protocol: ProtocolDefinition,
    action: ProtocolAction,
    fn: AbiFunction
  ) => void
): void {
  for (const protocol of getRegisteredProtocols()) {
    for (const action of protocol.actions) {
      if (action.type !== "read") {
        continue;
      }
      const fn = readAbiFunction(protocol, action);
      if (fn?.outputs) {
        visit(protocol, action, fn);
      }
    }
  }
}

describe("Protocol output field advertisements", () => {
  it("every advertised result path resolves in what structureAbiOutputs returns", () => {
    const violations: string[] = [];
    let checkedActions = 0;
    let checkedPaths = 0;

    eachReadAction((protocol, action, fn) => {
      const outputs = fn.outputs ?? [];
      // read-contract wraps a single decoded output in a one-element array
      // before calling this, so the positional form is the same either way.
      const structured = structureAbiOutputs(
        outputs.map((o) => sampleValue(o)),
        outputs
      );
      checkedActions++;

      for (const advertised of protocolActionToPluginAction(protocol, action)
        .outputFields ?? []) {
        const { field } = advertised;
        if (field === "result") {
          checkedPaths++;
          continue;
        }
        if (!field.startsWith("result.")) {
          continue;
        }
        checkedPaths++;
        if (!resolvePath(structured, field).found) {
          violations.push(
            `${protocol.slug}/${action.slug}: advertised "${field}" is not present in ${JSON.stringify(structured)}`
          );
        }
      }
    });

    expect(violations).toEqual([]);
    // Guards against the sweep silently covering nothing.
    expect(checkedActions).toBeGreaterThan(200);
    expect(checkedPaths).toBeGreaterThan(400);
  });

  it("puts every curated label on the path the runtime actually uses", () => {
    const problems: string[] = [];
    let curatedHits = 0;

    eachReadAction((protocol, action, fn) => {
      const outputs = fn.outputs ?? [];
      const derived = action.outputs ?? [];
      const id = `${protocol.slug}/${action.slug}`;

      // The positional join is only sound while the two lists line up, so pin
      // that rather than assume it.
      if (derived.length !== outputs.length) {
        problems.push(
          `${id}: action.outputs has ${derived.length} entries for ${outputs.length} ABI outputs`
        );
        return;
      }

      const advertised = new Map(
        (protocolActionToPluginAction(protocol, action).outputFields ?? []).map(
          (f) => [f.field, f.description]
        )
      );
      const paths = runtimePathByOutputIndex(outputs);

      for (const [index, output] of derived.entries()) {
        const label = output?.label;
        if (!label) {
          continue;
        }
        const path = paths[index];
        if (!path) {
          problems.push(
            `${id}: ABI output ${index} has no reachable runtime path, so "${label}" has nowhere to land`
          );
          continue;
        }
        // A missing path is a failure, not something to skip. Skipping it is
        // how a label silently stops being advertised at all, which is the
        // same defect as advertising the wrong path.
        if (!advertised.has(path)) {
          problems.push(
            `${id}: "${path}" holds this output at runtime and carries "${label}", but no such field is advertised`
          );
          continue;
        }
        if (advertised.get(path) === label) {
          curatedHits++;
          continue;
        }
        problems.push(
          `${id} ${path}: advertised "${advertised.get(path)}", curated label is "${label}"`
        );
      }
    });

    expect(problems).toEqual([]);
    // The lookup this replaced scored zero across the whole registry, so a
    // bare "no violations" assertion would have passed on it too.
    expect(curatedHits).toBeGreaterThan(400);
  });

  it("carries the curated label through a named multi-output view", () => {
    const aave = getRegisteredProtocols().find((p) => p.slug === "aave-v3");
    const action = aave?.actions.find(
      (a) => a.slug === "get-user-account-data"
    );
    expect(action).toBeDefined();
    const fields = new Map(
      (
        protocolActionToPluginAction(
          aave as ProtocolDefinition,
          action as ProtocolAction
        ).outputFields ?? []
      ).map((f) => [f.field, f.description])
    );

    expect(fields.get("result.healthFactor")).toBe("Health Factor");
    expect(fields.get("result.currentLiquidationThreshold")).toBe(
      "Liquidation Threshold (basis points)"
    );
    expect(fields.get("result.ltv")).toBe("Loan-to-Value (basis points)");
  });

  it("carries the curated label through an unnamed multi-output view", () => {
    // getUserDebt's ABI outputs are both unnamed, so the runtime keys are
    // unnamedOutput0/1 while the curated labels are authored under result0/1.
    // Those two names never coincide, which is why a name-keyed lookup here
    // could not work and position is what joins them.
    const aave = getRegisteredProtocols().find((p) => p.slug === "aave-v4");
    const action = aave?.actions.find((a) => a.slug === "get-user-debt");
    expect(action).toBeDefined();
    const fields = new Map(
      (
        protocolActionToPluginAction(
          aave as ProtocolDefinition,
          action as ProtocolAction
        ).outputFields ?? []
      ).map((f) => [f.field, f.description])
    );

    expect(fields.get("result.unnamedOutput0")).toBe("Drawn Debt (underlying)");
    expect(fields.get("result.unnamedOutput1")).toBe(
      "Premium Debt (underlying)"
    );
  });

  it("advertises the components of an unnamed single tuple", () => {
    // getUserAccountData returns one unnamed tuple. structureAbiValue unwraps
    // its components straight onto result. The action's own description tells
    // the author to bind result.healthFactor, so those paths have to be
    // advertised or the one documented binding is undiscoverable.
    const aave = getRegisteredProtocols().find((p) => p.slug === "aave-v4");
    const action = aave?.actions.find(
      (a) => a.slug === "get-user-account-data"
    );
    expect(action).toBeDefined();
    const fields = (
      protocolActionToPluginAction(
        aave as ProtocolDefinition,
        action as ProtocolAction
      ).outputFields ?? []
    ).map((f) => f.field);

    expect(fields).toContain("result.healthFactor");
    expect(fields).toContain("result.totalCollateralValue");
  });

  it("advertises the components of a named single tuple", () => {
    // quoteSend returns one named tuple. The curated label describes the whole
    // struct, so it lands on result.fee, and the components underneath it exist
    // only because the path derivation is shared with the Read Contract editor.
    // The shallower copy this replaced stopped at result.fee.
    const layerzero = getRegisteredProtocols().find(
      (p) => p.slug === "layerzero"
    );
    const action = layerzero?.actions.find((a) => a.slug === "oft-quote-send");
    expect(action).toBeDefined();
    const fields = new Map(
      (
        protocolActionToPluginAction(
          layerzero as ProtocolDefinition,
          action as ProtocolAction
        ).outputFields ?? []
      ).map((f) => [f.field, f.description])
    );

    expect(fields.get("result.fee")).toBe(
      "Messaging Fee (nativeFee, lzTokenFee, each in its token's smallest unit)"
    );
    expect([...fields.keys()]).toContain("result.fee.nativeFee");
    expect([...fields.keys()]).toContain("result.fee.lzTokenFee");
  });

  it("write actions advertise no result paths", () => {
    const offenders: string[] = [];
    let checked = 0;

    for (const protocol of getRegisteredProtocols()) {
      for (const action of protocol.actions) {
        if (action.type !== "write") {
          continue;
        }
        checked++;
        for (const field of protocolActionToPluginAction(protocol, action)
          .outputFields ?? []) {
          // writeContractCore returns result: undefined, so a result path here
          // would be a template suggestion that never resolves.
          if (field.field === "result" || field.field.startsWith("result.")) {
            offenders.push(`${protocol.slug}/${action.slug}: ${field.field}`);
          }
        }
      }
    }

    expect(offenders).toEqual([]);
    expect(checked).toBeGreaterThan(50);
  });
});
