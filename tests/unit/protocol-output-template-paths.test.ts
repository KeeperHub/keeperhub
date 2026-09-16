/**
 * Registry-wide invariant: every template path the builder suggests for a
 * protocol read must resolve against the shape the step actually returns.
 *
 * The instance that prompted this: a read action whose ABI output is unnamed
 * but which declares an `outputs` override. buildOutputFieldsFromAction
 * surfaced the override name as a suggestion while structureAbiOutputs, which
 * keys only off the raw ABI, returned the bare scalar under `result`. The
 * suggested path resolved to undefined silently - the workflow saved, ran, and
 * read empty.
 *
 * Asserting the whole registry rather than the three known actions is the
 * point: the same shape is one `outputs:` override away in any protocol, and
 * 24 of them already carried it.
 */

import { describe, expect, it } from "vitest";
import "@/protocols";
import {
  getRegisteredProtocols,
  type ProtocolAction,
  type ProtocolDefinition,
  protocolActionToPluginAction,
} from "@/lib/protocol-registry";
import {
  type AbiOutputParam,
  structureAbiOutputs,
} from "@/plugins/web3/steps/structure-abi-result";

/** Output fields the step adds regardless of the ABI; not template paths into
 *  the returned value, so they are not checked against the result shape. */
const ENVELOPE_FIELDS = new Set([
  "success",
  "error",
  "transactionHash",
  "transactionLink",
]);

/**
 * Faithful replica of the executor's three-shape walk
 * (resolveFromOutputData in lib/workflow/executor/executor.workflow.ts):
 * top-level, then `{ data: ... }`, then `{ result: ... }`. Replicated rather
 * than imported because the executor module pulls in the step registry, which
 * is generated and absent in a unit-test run.
 */
function walk(data: unknown, path: string): unknown {
  let current = data;
  for (const part of path.split(".")) {
    if (
      current === null ||
      current === undefined ||
      typeof current !== "object"
    ) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function resolveFromOutputData(data: unknown, fieldPath: string): unknown {
  const fromTop = fieldPath ? walk(data, fieldPath) : data;
  if (fromTop !== undefined && fromTop !== null) {
    return fromTop;
  }
  const record = data as Record<string, unknown> | null;
  if (record && typeof record.data === "object" && record.data !== null) {
    const fromInner = fieldPath ? walk(record.data, fieldPath) : record.data;
    if (fromInner !== undefined && fromInner !== null) {
      return fromInner;
    }
  }
  if (record && typeof record.result === "object" && record.result !== null) {
    return fieldPath ? walk(record.result, fieldPath) : record.result;
  }
  return undefined;
}

function findAbiOutputs(
  def: ProtocolDefinition,
  action: ProtocolAction
): AbiOutputParam[] | undefined {
  const raw = def.contracts[action.contract]?.abi;
  if (!raw) {
    return undefined;
  }
  const abi = JSON.parse(raw) as Array<{
    type?: string;
    name?: string;
    outputs?: AbiOutputParam[];
  }>;
  return abi.find((e) => e.type === "function" && e.name === action.function)
    ?.outputs;
}

/**
 * Build the value the step would return, with every leaf a distinct marker so
 * a path that resolves to the wrong leaf is still caught.
 */
function simulateStepOutput(
  outputs: AbiOutputParam[],
  declaredNames: (string | undefined)[] | undefined
): { success: true; result: unknown; addressLink: string } {
  const values = outputs.map((_, i) => `value-${i}`);
  return {
    success: true,
    result: structureAbiOutputs(
      outputs.length === 1 ? [values[0]] : values,
      outputs,
      declaredNames
    ),
    addressLink: "",
  };
}

/**
 * Every suggested field that does not resolve against the simulated result,
 * as "<protocol>/<action> .<field>".
 */
function unresolvableSuggestions(
  protocols: readonly ProtocolDefinition[]
): string[] {
  const offenders: string[] = [];
  for (const def of protocols) {
    for (const action of def.actions) {
      if (action.type !== "read") {
        continue;
      }
      const abiOutputs = findAbiOutputs(def, action);
      if (!abiOutputs || abiOutputs.length === 0) {
        continue;
      }
      const stepOutput = simulateStepOutput(
        abiOutputs,
        action.outputs?.map((o) => o.name)
      );
      const { outputFields } = protocolActionToPluginAction(def, action);
      for (const { field } of outputFields ?? []) {
        if (ENVELOPE_FIELDS.has(field)) {
          continue;
        }
        if (resolveFromOutputData(stepOutput, field) === undefined) {
          offenders.push(`${def.slug}/${action.slug} .${field}`);
        }
      }
    }
  }
  return offenders;
}

describe("protocol read output template paths", () => {
  it("every suggested field resolves against the shape the step returns", () => {
    expect(unresolvableSuggestions(getRegisteredProtocols())).toEqual([]);
  });

  it("covers a meaningful number of suggestions rather than passing vacuously", () => {
    // The assertion above would also hold if the walk silently stopped
    // finding actions. Pin that it is really exercising the registry.
    let suggestions = 0;
    for (const def of getRegisteredProtocols()) {
      for (const action of def.actions) {
        if (action.type === "read" && action.outputs) {
          suggestions += action.outputs.length;
        }
      }
    }
    expect(suggestions).toBeGreaterThan(400);
  });

  it("catches an override that names an output the ABI leaves unnamed", () => {
    // The exact regression: without the declared-name fallback reaching
    // structureAbiOutputs, the suggestion `approvalRequired` resolves to
    // undefined because the value sits bare under `result`. Built as a
    // synthetic definition so the detector is proven to fire without
    // depending on a real protocol staying broken.
    const def: ProtocolDefinition = {
      name: "Unnamed Output Fixture",
      slug: "zz-unnamed-output-fixture",
      description: "fixture",
      contracts: {
        c: {
          label: "C",
          addresses: { "1": "0x0000000000000000000000000000000000000001" },
          abi: JSON.stringify([
            {
              name: "approvalRequired",
              type: "function",
              stateMutability: "view",
              inputs: [],
              outputs: [{ name: "", type: "bool" }],
            },
          ]),
        },
      },
      actions: [
        {
          slug: "approval-required",
          label: "Approval Required",
          description: "fixture action",
          type: "read",
          contract: "c",
          function: "approvalRequired",
          inputs: [],
          outputs: [
            {
              name: "approvalRequired",
              type: "bool",
              label: "Approval Required",
            },
          ],
        },
      ],
    };

    const abiOutputs = findAbiOutputs(def, def.actions[0]);
    expect(abiOutputs).toBeDefined();

    // With the declared name passed through, the path resolves.
    expect(
      resolveFromOutputData(
        simulateStepOutput(abiOutputs as AbiOutputParam[], [
          "approvalRequired",
        ]),
        "approvalRequired"
      )
    ).toBe("value-0");

    // Without it - the pre-fix behaviour - the same path is undefined, which
    // is what the registry-wide assertion is protecting against.
    expect(
      resolveFromOutputData(
        simulateStepOutput(abiOutputs as AbiOutputParam[], undefined),
        "approvalRequired"
      )
    ).toBeUndefined();
  });

  it("never lets a declared name shadow a name the ABI supplies", () => {
    const outputs: AbiOutputParam[] = [{ name: "fee", type: "uint256" }];
    // A stale or mistaken override must not rename a real ABI output: the ABI
    // is authoritative, and renaming it would break paths that work today.
    expect(structureAbiOutputs(["1"], outputs, ["somethingElse"])).toEqual({
      fee: "1",
    });
  });
});
