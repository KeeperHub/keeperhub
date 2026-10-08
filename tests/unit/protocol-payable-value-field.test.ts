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
  clearEncodeTransforms,
  getEncodeTransformKind,
  registerEncodeTransform,
  weiToEther,
} from "@/lib/protocol-encode-transforms";
import {
  type AbiFunctionOverride,
  defineAbiProtocol,
  defineProtocol,
  getProtocol,
  getRegisteredProtocols,
  type ProtocolAction,
  type ProtocolDefinition,
  protocolActionToPluginAction,
} from "@/lib/protocol-registry";
import { validateWorkflowActionConfigs } from "@/lib/workflow/validation/action-config";
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

function configFieldKeys(fields: ActionConfigField[]): string[] {
  const keys: string[] = [];
  for (const field of fields) {
    if ("key" in field) {
      keys.push(field.key);
    } else {
      keys.push(...configFieldKeys(field.fields));
    }
  }
  return keys;
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
    // allowed to differ from the historical shape - and one declaring
    // payableValue.fromInput is allowed to differ in the biggest way: no
    // value field at all, because the value is taken from a declared input.
    const declared: string[] = [];
    for (const def of getRegisteredProtocols()) {
      for (const action of def.actions) {
        if (!action.payable) {
          continue;
        }
        if (action.payableValue) {
          declared.push(`${def.slug}/${action.slug}`);
          if (action.payableValue.fromInput) {
            const keys = configFieldKeys(
              protocolActionToPluginAction(def, action).configFields
            );
            expect(keys, `${def.slug}/${action.slug}`).not.toContain(
              "ethValue"
            );
          }
          continue;
        }
        const field = ethValueField(def, action);
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
    const def = defineAbiProtocol({
      name: "Synthetic Label",
      slug: "zz-synthetic-label",
      description: "fixture",
      contracts: {
        c: {
          label: "C",
          abi: PAYABLE_ABI,
          addresses: { "1": "0x0000000000000000000000000000000000000001" },
          overrides: {
            deposit: {
              payableValue: {
                label: "Deposit (wei)",
                placeholder: "0",
                helpTip: "In wei.",
                docUrl: "https://example.com/docs",
              },
            },
          },
        },
      },
    });
    const action = def.actions.find((a) => a.slug === "deposit");
    if (!action) {
      throw new Error("deposit not derived");
    }
    const field = ethValueField(def, action);
    expect(field.label).toBe("Deposit (wei)");
    expect(field.placeholder).toBe("0");
    expect(field.helpTip).toBe("In wei.");
    expect(field.docUrl).toBe("https://example.com/docs");
  });

  it("validates a wei value field as a required uint256, keyed off the transform", () => {
    // The field's type follows the transform registry, not the label: an
    // action with weiToEther on ethValue gets integer validation and is
    // required. Checked here through the registry builder and below through
    // the workflow validator, which is what a save actually runs.
    registerEncodeTransform(
      "zz-synthetic-wei",
      "deposit",
      "ethValue",
      weiToEther,
      "weiToEther"
    );
    try {
      const def = defineAbiProtocol({
        name: "Synthetic Wei",
        slug: "zz-synthetic-wei",
        description: "fixture",
        contracts: {
          c: {
            label: "C",
            abi: PAYABLE_ABI,
            addresses: {
              "1": "0x0000000000000000000000000000000000000001",
            },
            overrides: {
              deposit: { payableValue: { label: "Deposit (wei)" } },
            },
          },
        },
      });
      const action = def.actions.find((a) => a.slug === "deposit");
      if (!action) {
        throw new Error("deposit not derived");
      }
      expect(
        getEncodeTransformKind("zz-synthetic-wei", "deposit", "ethValue")
      ).toBe("weiToEther");
      const field = ethValueField(def, action);
      expect(field.type).toBe("protocol-uint");
      expect(field.solidityType).toBe("uint256");
      expect(field.required).toBe(true);
      expect(field.label).toBe("Deposit (wei)");
    } finally {
      clearEncodeTransforms();
    }
  });

  it("refuses a decimal or blank fee on the uint256 fee field and accepts integers and templates", () => {
    // The OFT send takes msg.value from nativeFee, so the wei-typed field
    // the validator has to police is the fee input itself: the same
    // protocol-uint rules the removed value field carried.
    const wallet = "0x1111111111111111111111111111111111111111";
    const base = {
      actionType: "layerzero/oft-send",
      network: "1",
      contractAddress: "0x6C96dE32CEa08842dcc4058c14d3aaAD7Fa41dee",
      dstEid: "30110",
      to: wallet,
      amountLD: "1000000",
      minAmountLD: "990000",
    };
    const issuesFor = (nativeFee: unknown) =>
      validateWorkflowActionConfigs([
        {
          id: "send-1",
          type: "action",
          data: {
            type: "action",
            label: "OFT Send",
            config: nativeFee === undefined ? base : { ...base, nativeFee },
          },
        },
      ]).issues.filter((issue) => issue.field === "nativeFee");

    // Ether typed into the wei field: refused at save time rather than at
    // run time.
    expect(issuesFor("0.001").map((i) => i.code)).not.toEqual([]);
    expect(issuesFor("").map((i) => i.code)).toEqual([
      "MISSING_REQUIRED_FIELD",
    ]);
    expect(issuesFor(undefined).map((i) => i.code)).toEqual([
      "MISSING_REQUIRED_FIELD",
    ]);
    // A JSON number is refused too: only a string carries wei exactly.
    expect(issuesFor(218_756_042_576_226)).not.toEqual([]);
    expect(issuesFor("218756042576226")).toEqual([]);
    expect(issuesFor("{{@quote:OFT Quote Send.fee.nativeFee}}")).toEqual([]);
  });

  it("keeps decimal validation and optionality on an ether value field", () => {
    // wrapped/wrap: no transform, so the historical decimal field, required
    // because it is the action's only input.
    const issuesFor = (config: Record<string, unknown>) =>
      validateWorkflowActionConfigs([
        {
          id: "wrap-1",
          type: "action",
          data: {
            type: "action",
            label: "Wrap",
            config: { actionType: "wrapped/wrap", network: "1", ...config },
          },
        },
      ]).issues.filter((issue) => issue.field === "ethValue");
    expect(issuesFor({ ethValue: "0.5" })).toEqual([]);
    expect(issuesFor({ ethValue: "abc" }).length).toBeGreaterThan(0);
    expect(issuesFor({}).map((i) => i.code)).toEqual([
      "MISSING_REQUIRED_FIELD",
    ]);
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

describe("payer input and payableValue.fromInput hooks", () => {
  // A payable function whose native value is carried by one of its declared
  // inputs (msg.value === amount) rather than by a separate value field, and
  // whose refund address argument is set by the write core to the address
  // that pays instead of being typed by the user.
  const PAYER_ABI = JSON.stringify([
    {
      type: "function",
      name: "pay",
      stateMutability: "payable",
      inputs: [
        { name: "amount", type: "uint256" },
        { name: "refund", type: "address" },
      ],
      outputs: [],
    },
  ]);

  function syntheticDefinition(
    payOverride: AbiFunctionOverride = {
      payableValue: { fromInput: "amount" },
      inputs: { refund: { payer: true } },
    }
  ): ProtocolDefinition {
    return defineAbiProtocol({
      name: "Synthetic Pay",
      slug: "zz-synthetic-pay",
      description: "fixture",
      contracts: {
        c: {
          label: "C",
          abi: PAYER_ABI,
          addresses: { "1": "0x0000000000000000000000000000000000000001" },
          overrides: { pay: payOverride },
        },
      },
    });
  }

  function syntheticAction(def: ProtocolDefinition): ProtocolAction {
    const action = def.actions.find((a) => a.slug === "pay");
    if (!action) {
      throw new Error("pay action not derived");
    }
    return action;
  }

  it("derives payableValue.fromInput and marks the payer input", () => {
    const pay = syntheticAction(syntheticDefinition());
    expect(pay.payableValue?.fromInput).toBe("amount");
    expect(pay.inputs.find((i) => i.name === "refund")?.payer).toBe(true);
    expect(pay.inputs.find((i) => i.name === "amount")?.payer).toBeUndefined();
  });

  it("renders neither the ethValue field nor the payer input", () => {
    const def = syntheticDefinition();
    const keys = configFieldKeys(
      protocolActionToPluginAction(def, syntheticAction(def)).configFields
    );
    expect(keys).not.toContain("ethValue");
    expect(keys).not.toContain("refund");
    expect(keys).toContain("amount");
  });

  it("refuses a fromInput that names no user input", () => {
    expect(() =>
      syntheticDefinition({ payableValue: { fromInput: "missing" } })
    ).toThrow(/payableValue\.fromInput "missing" must name a user input/);
    // Naming the payer input is refused the same way: it is not a user field.
    expect(() =>
      syntheticDefinition({
        payableValue: { fromInput: "refund" },
        inputs: { refund: { payer: true } },
      })
    ).toThrow(/payableValue\.fromInput "refund" must name a user input/);
  });

  it("refuses payer on a non-address input", () => {
    expect(() =>
      syntheticDefinition({ inputs: { amount: { payer: true } } })
    ).toThrow(/payer input "amount" must be an address parameter, got uint256/);
  });

  it("refuses a rename on a payer input", () => {
    expect(() =>
      syntheticDefinition({
        inputs: { refund: { payer: true, name: "refundTo" } },
      })
    ).toThrow(/payer input "refund" cannot be renamed/);
  });

  it("keeps the historical ethValue field on a payable action declaring neither hook", () => {
    const def = syntheticDefinition({});
    const field = ethValueField(def, syntheticAction(def));
    expect(field).toEqual({
      key: "ethValue",
      label: "ETH Value",
      type: "protocol-eth-value",
      placeholder: "0.0",
      required: false,
    });
  });
});

/**
 * The authoring-time guards around `payer` and `payableValue.fromInput`.
 * Each one fails closed at run time as well, so what these pin is that a
 * definition in that state never reaches a deploy in the first place.
 */
describe("payer and payableValue authoring guards", () => {
  const PAYER_ABI = JSON.stringify([
    {
      type: "function",
      name: "collect",
      stateMutability: "payable",
      inputs: [
        { name: "from", type: "uint256" },
        { name: "fee", type: "uint256" },
      ],
      outputs: [],
    },
  ]);

  const TUPLE_ABI = JSON.stringify([
    {
      type: "function",
      name: "send",
      stateMutability: "payable",
      inputs: [
        {
          name: "params",
          type: "tuple",
          components: [{ name: "payer", type: "address" }],
        },
      ],
      outputs: [],
    },
  ]);

  function derive(abi: string, overrides: Record<string, unknown>): unknown {
    return deriveActionsFromAbi("c", {
      label: "C",
      abi,
      addresses: {},
      overrides: overrides as Record<string, AbiFunctionOverride>,
    });
  }

  it("refuses a payer override on a parameter that is not an address", () => {
    expect(() =>
      derive(PAYER_ABI, { collect: { inputs: { from: { payer: true } } } })
    ).toThrow(/must be an address parameter/);
  });

  it("refuses a payer override on a tuple component", () => {
    expect(() =>
      derive(TUPLE_ABI, { send: { inputs: { payer: { payer: true } } } })
    ).toThrow(/top-level parameters only/);
  });

  it("refuses payableValue.fromInput naming an input that does not exist", () => {
    expect(() =>
      derive(PAYER_ABI, { collect: { payableValue: { fromInput: "nope" } } })
    ).toThrow(/must name a user input/);
  });

  it("refuses a hand-written payer input that is not an address", () => {
    const definition = {
      slug: "zz-payer-guard",
      name: "ZZ",
      label: "ZZ",
      description: "guard fixture",
      contracts: { c: { label: "C", addresses: {} } },
      actions: [
        {
          slug: "zz-payer-guard-collect",
          label: "Collect",
          description: "guard fixture",
          type: "write",
          contract: "c",
          function: "collect",
          abi: "function collect(uint256 from)",
          kind: "write",
          inputs: [{ name: "from", type: "uint256", payer: true }],
        },
      ],
    } as unknown as ProtocolDefinition;
    expect(() => defineProtocol(definition)).toThrow(
      /must be an address parameter/
    );
  });
});
