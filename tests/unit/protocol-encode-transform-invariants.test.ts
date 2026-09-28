/**
 * Registry-wide invariants for encode transforms.
 *
 * Nothing here mutates the transform registry. An earlier revision cleared
 * it to undo a deliberate bad registration, which wiped the two eager
 * production entries for the rest of the file and would have silently
 * emptied the registry under any later test that audits it. The detector
 * takes the entries as an argument instead, so the live-registry case and
 * the synthetic violation both run against the same function with no
 * shared state between them.
 */

import { describe, expect, it } from "vitest";
import "@/protocols";
import {
  listEncodeTransforms,
  orphanEncodeTransforms,
  type RegisteredEncodeTransform,
  registerEncodeTransform,
  unregisterEncodeTransform,
  weiToEther,
} from "@/lib/protocol-encode-transforms";
import {
  getProtocol,
  getRegisteredProtocols,
  registerProtocol,
} from "@/lib/protocol-registry";

/**
 * weiToEther registered on a declared ABI input would diverge the runtime
 * from the emitted SDK: protocol-write.ts converts the value while the
 * synthesiser's weiToEther branch emits the raw expression. The kind exists
 * for the virtual ethValue field, which is not an ABI input.
 */
function weiToEtherOnDeclaredAbiInputs(
  entries: readonly RegisteredEncodeTransform[]
): string[] {
  const offenders: string[] = [];
  for (const t of entries) {
    if (t.kind !== "weiToEther") {
      continue;
    }
    const action = getProtocol(t.protocolSlug)?.actions.find(
      (a) => a.slug === t.actionSlug
    );
    if (action?.inputs.some((i) => i.name === t.inputName)) {
      offenders.push(`${t.protocolSlug}/${t.actionSlug}/${t.inputName}`);
    }
  }
  return offenders;
}

/** A real registered action that declares at least one ABI input. */
function anyActionWithInputs(): {
  protocolSlug: string;
  actionSlug: string;
  inputName: string;
} {
  for (const protocol of getRegisteredProtocols()) {
    for (const action of protocol.actions) {
      if (action.inputs.length > 0) {
        return {
          protocolSlug: protocol.slug,
          actionSlug: action.slug,
          inputName: action.inputs[0].name,
        };
      }
    }
  }
  throw new Error("registry has no action declaring inputs");
}

describe("encode transform registry invariants", () => {
  it("registers weiToEther only on virtual fields, never on an ABI input", () => {
    expect(weiToEtherOnDeclaredAbiInputs(listEncodeTransforms())).toEqual([]);
  });

  it("the detector catches a violation rather than passing vacuously", () => {
    // Nothing registers weiToEther in production today, so the assertion
    // above would hold even if this function stopped working. Feed it a
    // synthetic entry naming a real action and a real declared input of
    // that action, without touching the registry.
    const { protocolSlug, actionSlug, inputName } = anyActionWithInputs();
    const synthetic: RegisteredEncodeTransform[] = [
      { protocolSlug, actionSlug, inputName, kind: "weiToEther" },
    ];
    expect(weiToEtherOnDeclaredAbiInputs(synthetic)).toEqual([
      `${protocolSlug}/${actionSlug}/${inputName}`,
    ]);
  });

  it("refuses the illegal registration at registration time, not only in CI", () => {
    // The guard in registerEncodeTransform is what makes the invariant
    // unbreakable; the two tests above are the backstop for the ordering it
    // cannot see (a transform registered before its protocol exists, which
    // registerProtocol re-checks).
    const { protocolSlug, actionSlug, inputName } = anyActionWithInputs();
    expect(() =>
      registerEncodeTransform(
        protocolSlug,
        actionSlug,
        inputName,
        weiToEther,
        "weiToEther"
      )
    ).toThrow(/declared ABI input/);
    // The refusal must not leave a partial entry behind.
    expect(weiToEtherOnDeclaredAbiInputs(listEncodeTransforms())).toEqual([]);
  });
});

describe("registerProtocol refuses an illegal pairing without leaving state", () => {
  it("does not register the protocol when the transform guard throws", () => {
    // Order matters and is easy to get wrong: if the protocol were
    // inserted first and the guard threw afterwards, a caller that catches
    // the throw would be left holding exactly the pairing the guard exists
    // to prevent - the protocol resolvable, the illegal transform live, and
    // the write step applying a 10^18 conversion to an ABI arg. At module
    // load the throw kills the process either way; this pins the ordering
    // for every other caller.
    const slug = "zz-guard-ordering-fixture";
    registerEncodeTransform(slug, "act", "amount", weiToEther, "weiToEther");
    try {
      expect(() =>
        registerProtocol({
          name: "Guard Ordering Fixture",
          slug,
          description: "fixture",
          contracts: {
            c: {
              label: "C",
              addresses: { "1": "0x0000000000000000000000000000000000000001" },
              abi: '[{"name":"act","type":"function","inputs":[{"name":"amount","type":"uint256"}],"outputs":[]}]',
            },
          },
          actions: [
            {
              slug: "act",
              label: "Act",
              description: "fixture action",
              type: "write",
              contract: "c",
              function: "act",
              inputs: [{ name: "amount", type: "uint256", label: "Amount" }],
            },
          ],
        })
      ).toThrow(/declared ABI input/);
      expect(getProtocol(slug)).toBeUndefined();
    } finally {
      unregisterEncodeTransform(slug, "act", "amount");
    }
  });
});

describe("encode transform registrations resolve", () => {
  const resolveAction = (protocolSlug: string, actionSlug: string) =>
    getProtocol(protocolSlug)?.actions.find((a) => a.slug === actionSlug)
      ?.inputs;

  it("every registered transform names a protocol and action that exist", () => {
    // A typo'd slug is accepted by registerEncodeTransform, never applied
    // by the runtime, and invisible to the weiToEther guard, which cannot
    // judge an action it cannot find. The registration reads as done while
    // the step goes on parsing a raw wei quote as ether. This file imports
    // @/protocols first, so anything unresolved here is a typo rather than
    // a load-order artefact.
    expect(orphanEncodeTransforms(resolveAction)).toEqual([]);
  });

  it("the orphan detector catches a typo'd slug", () => {
    // Same reason the weiToEther detector has a paired test: with the
    // registry clean, the assertion above would hold even if this stopped
    // working. Register a deliberate typo, confirm it is caught, then
    // remove it - registerEncodeTransform accepts it precisely because the
    // guard cannot resolve it, which is the hole being pinned.
    registerEncodeTransform(
      "no-such-protocol",
      "no-such-action",
      "ethValue",
      weiToEther,
      "weiToEther"
    );
    try {
      expect(orphanEncodeTransforms(resolveAction)).toEqual([
        "no-such-protocol/no-such-action/ethValue",
      ]);
    } finally {
      unregisterEncodeTransform(
        "no-such-protocol",
        "no-such-action",
        "ethValue"
      );
    }
    expect(orphanEncodeTransforms(resolveAction)).toEqual([]);
  });
});

describe("protocol action lookup invariants", () => {
  it("no protocol has two actions sharing one (contract, function) pair", () => {
    // protocol-write.ts resolves the executing action with
    // `.find(a => a.function === fn && a.contract === key)`, and
    // protocol-derive.ts derives an action's slug from the function name,
    // so two overloads of one name on one contract would produce
    // indistinguishable actions and `.find` would take the first. That used
    // to decide only which ABI-arg transforms ran; since the payable value
    // resolves through the same lookup it now decides msg.value too.
    const collisions: string[] = [];
    for (const protocol of getRegisteredProtocols()) {
      const seen = new Set<string>();
      for (const a of protocol.actions) {
        const key = `${a.contract}.${a.function}`;
        if (seen.has(key)) {
          collisions.push(`${protocol.slug}: ${key}`);
        }
        seen.add(key);
      }
    }
    expect(collisions).toEqual([]);
  });
});
