/**
 * The payable value field's label hook (lib/protocol-registry.ts,
 * buildPayableValueField). Every payable action gets a virtual `ethValue`
 * field; an action may declare a label and help text for it through
 * `payableValue` in its ABI override. The property that matters is the
 * negative one: an action that declares nothing must render the field
 * exactly as it did before the hook existed, across the whole registry,
 * because those fields are typed in ether and their users have not been
 * told anything changed.
 */

import { describe, expect, it } from "vitest";
import "@/protocols";
import { deriveActionsFromAbi } from "@/lib/abi/protocol-derive";
import {
  defineProtocol,
  getProtocol,
  getRegisteredProtocols,
  type ProtocolAction,
  type ProtocolDefinition,
  protocolActionToPluginAction,
} from "@/lib/protocol-registry";
import type { ActionConfigField } from "@/plugins/registry";

const PAYABLE_ABI = JSON.stringify([
  {
    type: "function",
    name: "deposit",
    stateMutability: "payable",
    inputs: [],
    outputs: [],
  },
  {
    type: "function",
    name: "withdraw",
    stateMutability: "nonpayable",
    inputs: [{ name: "wad", type: "uint256" }],
    outputs: [],
  },
]);

function ethValueField(
  def: ProtocolDefinition,
  action: ProtocolAction
): Extract<ActionConfigField, { key: string }> {
  const field = protocolActionToPluginAction(def, action).configFields.find(
    (f) => "key" in f && f.key === "ethValue"
  );
  if (!(field && "key" in field)) {
    throw new Error(`${def.slug}/${action.slug} has no ethValue field`);
  }
  return field;
}

function requireProtocol(slug: string): ProtocolDefinition {
  const def = getProtocol(slug);
  if (!def) {
    throw new Error(`${slug} not registered`);
  }
  return def;
}

describe("payable value field label hook", () => {
  it("renders the historical field for an action that declares nothing", () => {
    // wrapped/wrap is the zero-argument payable case, where the field is
    // also required. Pinned field by field rather than by snapshot so the
    // assertion says which property moved.
    const wrapped = requireProtocol("wrapped");
    const wrap = wrapped.actions.find((a) => a.slug === "wrap");
    if (!wrap) {
      throw new Error("wrapped/wrap not registered");
    }
    expect(wrap.payableValue).toBeUndefined();
    const field = ethValueField(wrapped, wrap);
    expect(field).toEqual({
      key: "ethValue",
      label: "ETH Value",
      type: "protocol-eth-value",
      placeholder: "0.0",
      required: true,
    });
  });

  it("leaves every payable action in the registry that declares nothing unchanged", () => {
    // Registry-wide, so a future override cannot quietly relabel a field
    // whose unit did not change. Only actions carrying a declaration are
    // allowed to differ from the historical shape.
    const declared: string[] = [];
    for (const def of getRegisteredProtocols()) {
      for (const action of def.actions) {
        if (!action.payable) {
          continue;
        }
        const field = ethValueField(def, action);
        if (action.payableValue) {
          declared.push(`${def.slug}/${action.slug}`);
          continue;
        }
        expect(field, `${def.slug}/${action.slug}`).toEqual({
          key: "ethValue",
          label: "ETH Value",
          type: "protocol-eth-value",
          placeholder: "0.0",
          required: action.inputs.length === 0,
        });
      }
    }
    // The one action whose value field is wei. Add to this list only with
    // a weiToEther registration on the same action, or the label lies.
    expect(declared).toEqual(["layerzero/oft-send"]);
  });

  it("applies a declared label, placeholder, help text and docUrl", () => {
    const layerzero = requireProtocol("layerzero");
    const send = layerzero.actions.find((a) => a.slug === "oft-send");
    if (!send) {
      throw new Error("layerzero/oft-send not registered");
    }
    const field = ethValueField(layerzero, send);
    expect(field.label).toBe(send.payableValue?.label);
    expect(field.placeholder).toBe(send.payableValue?.placeholder);
    expect(field.helpTip).toBe(send.payableValue?.helpTip);
    expect(field.docUrl).toBe(send.payableValue?.docUrl);
    // The type is unchanged: the hook relabels the field, it does not
    // swap the input component or its validation.
    expect(field.type).toBe("protocol-eth-value");
  });

  it("derives payableValue onto a payable function and omits it otherwise", () => {
    const [deposit, withdraw] = deriveActionsFromAbi("weth", {
      label: "WETH",
      abi: PAYABLE_ABI,
      addresses: {},
      overrides: {
        deposit: {
          payableValue: { label: "Deposit (wei)", helpTip: "In wei." },
        },
      },
    });
    expect(deposit.payable).toBe(true);
    expect(deposit.payableValue).toEqual({
      label: "Deposit (wei)",
      helpTip: "In wei.",
    });
    expect(withdraw.payable).toBeUndefined();
    expect(withdraw.payableValue).toBeUndefined();
  });

  it("refuses payableValue on a non-payable function instead of dropping it", () => {
    // A label for a field that never renders would otherwise be accepted
    // silently, and the author would believe the unit was communicated.
    expect(() =>
      deriveActionsFromAbi("weth", {
        label: "WETH",
        abi: PAYABLE_ABI,
        addresses: {},
        overrides: {
          withdraw: { payableValue: { label: "Nope" } },
        },
      })
    ).toThrow(/declares payableValue, but the function is nonpayable/);
  });

  it("refuses payableValue on a non-payable action in a hand-written definition", () => {
    // Same rule for a definition that never passes through the deriver.
    expect(() =>
      defineProtocol({
        name: "Hand Written",
        slug: "zz-hand-written-fixture",
        description: "fixture",
        contracts: {
          c: {
            label: "C",
            addresses: { "1": "0x0000000000000000000000000000000000000001" },
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
            inputs: [],
            payableValue: { label: "Nope" },
          },
        ],
      })
    ).toThrow(/declares payableValue but is not payable/);
  });
});
