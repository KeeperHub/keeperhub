import { ethers } from "ethers";
import { describe, expect, it } from "vitest";
import {
  getEncodeTransform,
  getEncodeTransformKind,
  listEncodeTransforms,
} from "@/lib/protocol-encode-transforms";
import {
  getProtocol,
  protocolActionToPluginAction,
  registerProtocol,
} from "@/lib/protocol-registry";
import layerzeroErc20Abi from "@/protocols/abis/layerzero-erc20.json";
import layerzeroOftAbi from "@/protocols/abis/layerzero-oft.json";
import layerzeroDef, {
  DEFAULT_EXTRA_OPTIONS,
  LAYERZERO_CONFIG_DOCS,
  LAYERZERO_DEPLOYMENTS_DOCS,
  LAYERZERO_EIDS,
  LAYERZERO_OFT_DOCS,
  LAYERZERO_PROTOCOL_DOCS,
  OFT_SEND_FIXTURE_FEE_WEI,
} from "@/protocols/layerzero";

const KEBAB_CASE_REGEX = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const HEX_ADDRESS_REGEX = /^0x[0-9a-fA-F]{40}$/;
const ALLOWED_DOC_URLS = new Set([
  LAYERZERO_OFT_DOCS,
  LAYERZERO_PROTOCOL_DOCS,
  LAYERZERO_CONFIG_DOCS,
  LAYERZERO_DEPLOYMENTS_DOCS,
]);
const ENDPOINT_MAINNET = "0x1a44076050125825900e736c501f859c50fE728c";
const ENDPOINT_TESTNET = "0x6EDCE65403992e310A62460808c4b910D972f10f";

const READ_SLUGS = [
  "oft-quote-send",
  "oft-quote-oft",
  "oft-approval-required",
  "oft-shared-decimals",
  "oft-token",
  "oft-peer",
  "oft-check-balance",
  "oft-check-allowance",
  "endpoint-get-send-library",
  "endpoint-get-config",
  "endpoint-is-supported-eid",
];
const WRITE_SLUGS = ["oft-send", "oft-approve"];

// send((uint32,bytes32,uint256,uint256,bytes,bytes,bytes),(uint256,uint256),address),
// the selector the USDT0 adapter was called with in the mainnet transfer
// the issue cites (0x23b8fd4b...). A renamed param or a re-typed tuple
// member changes the selector and the deployed contract stops matching.
const OFT_SEND_SELECTOR = "0xc7c7f5b3";
// keccak256("OFTSent(bytes32,uint32,address,uint256,uint256)"), the topic0
// of the OFTSent log that same transaction emitted (3 topics: guid and
// fromAddress indexed).
const OFT_SENT_TOPIC =
  "0x85496b760a4b7f8d66384b9df21b381f5d1b1e79f229a47aaf4c232edc2fe59a";
const SEND_PARAM_INPUT_NAMES = [
  "dstEid",
  "to",
  "amountLD",
  "minAmountLD",
  "extraOptions",
  "composeMsg",
  "oftCmd",
];

function action(slug: string) {
  const found = layerzeroDef.actions.find((a) => a.slug === slug);
  if (!found) {
    throw new Error(`action ${slug} not found`);
  }
  return found;
}

describe("LayerZero Protocol Definition (ABI-driven)", () => {
  it("imports without throwing", () => {
    expect(layerzeroDef.name).toBe("LayerZero");
    expect(layerzeroDef.slug).toBe("layerzero");
  });

  it("all action slugs are valid kebab-case", () => {
    for (const a of layerzeroDef.actions) {
      expect(a.slug).toMatch(KEBAB_CASE_REGEX);
    }
  });

  it("has exactly the thirteen accepted actions: eleven reads and two writes", () => {
    const slugs = layerzeroDef.actions.map((a) => a.slug).sort();
    expect(slugs).toEqual([...READ_SLUGS, ...WRITE_SLUGS].sort());
    for (const slug of READ_SLUGS) {
      expect(action(slug).type, slug).toBe("read");
    }
    for (const slug of WRITE_SLUGS) {
      expect(action(slug).type, slug).toBe("write");
    }
  });

  it("every action references an existing contract", () => {
    const keys = new Set(Object.keys(layerzeroDef.contracts));
    for (const a of layerzeroDef.actions) {
      expect(keys.has(a.contract), `${a.slug} -> ${a.contract}`).toBe(true);
    }
  });

  it("all read actions define outputs", () => {
    for (const a of layerzeroDef.actions.filter((x) => x.type === "read")) {
      expect(a.outputs?.length, a.slug).toBeGreaterThan(0);
    }
  });

  it("all contract addresses are valid hex", () => {
    for (const [key, c] of Object.entries(layerzeroDef.contracts)) {
      for (const [chain, addr] of Object.entries(c.addresses)) {
        expect(addr, `${key}/${chain}`).toMatch(HEX_ADDRESS_REGEX);
      }
    }
  });

  it("endpointV2 is fixed-address on the seven supported chains", () => {
    const ep = layerzeroDef.contracts.endpointV2;
    expect(ep.userSpecifiedAddress).toBeUndefined();
    expect(Object.keys(ep.addresses).sort()).toEqual(
      ["1", "10", "137", "8453", "42161", "11155111", "84532"].sort()
    );
    for (const chain of ["1", "10", "137", "8453", "42161"]) {
      expect(ep.addresses[chain]).toBe(ENDPOINT_MAINNET);
    }
    for (const chain of ["11155111", "84532"]) {
      expect(ep.addresses[chain]).toBe(ENDPOINT_TESTNET);
    }
  });

  it("oft and oftToken are user-specified-address contracts", () => {
    expect(layerzeroDef.contracts.oft.userSpecifiedAddress).toBe(true);
    expect(layerzeroDef.contracts.oftToken.userSpecifiedAddress).toBe(true);
  });

  it("oft and oftToken cover exactly the endpoint's chains", () => {
    // The reference maps are fallbacks for a user-specified address, so a
    // chain silently missing from one of them does not fail any hex-shape
    // check - it just leaves that chain with no default target. Pin the
    // membership, not only the shape, and pin it against endpointV2 so
    // adding a chain to one map without the others fails here.
    const chains = Object.keys(
      layerzeroDef.contracts.endpointV2.addresses
    ).sort();
    for (const key of ["oft", "oftToken"] as const) {
      expect(
        Object.keys(layerzeroDef.contracts[key].addresses).sort(),
        key
      ).toEqual(chains);
    }
  });

  it("pins the testnet pairs where the OFT is its own token", () => {
    // On the two testnet entries the OFT is the token, so both maps hold
    // the same address. On the five mainnet entries they must differ: an
    // adapter that returned itself from token() would mean the reference
    // pair was mis-transcribed.
    const oft = layerzeroDef.contracts.oft.addresses;
    const token = layerzeroDef.contracts.oftToken.addresses;
    for (const chain of ["11155111", "84532"]) {
      expect(token[chain], chain).toBe(oft[chain]);
    }
    for (const chain of ["1", "10", "137", "8453", "42161"]) {
      expect(token[chain], chain).not.toBe(oft[chain]);
    }
  });

  it("peers is an OFT read, not an endpoint read", () => {
    const peer = action("oft-peer");
    expect(peer.contract).toBe("oft");
    expect(peer.function).toBe("peers");
    expect(peer.inputs).toHaveLength(1);
    expect(peer.inputs[0].name).toBe("eid");
  });

  it("quote-send flattens SendParam plus payInLzToken into eight inputs", () => {
    const q = action("oft-quote-send");
    expect(q.contract).toBe("oft");
    expect(q.inputs.map((i) => i.name)).toEqual([
      ...SEND_PARAM_INPUT_NAMES,
      "payInLzToken",
    ]);
    expect(q.outputs?.map((o) => o.name)).toEqual(["fee"]);
  });

  it("send flattens SendParam, MessagingFee and refundAddress into ten inputs", () => {
    const s = action("oft-send");
    expect(s.contract).toBe("oft");
    expect(s.function).toBe("send");
    expect(s.type).toBe("write");
    expect(s.payable).toBe(true);
    // The SendParam prefix is identical to the quote's, so a workflow can
    // pass the same values to both.
    expect(s.inputs.map((i) => i.name)).toEqual([
      ...SEND_PARAM_INPUT_NAMES,
      "nativeFee",
      "lzTokenFee",
      "refundAddress",
    ]);
    const quoteParams = action("oft-quote-send").inputs.slice(0, 7);
    expect(s.inputs.slice(0, 7)).toEqual(quoteParams);
  });

  it("send's selector matches the deployed adapter and OFTSent has the expected topic", () => {
    const iface = new ethers.Interface(layerzeroOftAbi);
    expect(iface.getFunction("send")?.selector).toBe(OFT_SEND_SELECTOR);
    const evt = iface.getEvent("OFTSent");
    expect(evt?.topicHash).toBe(OFT_SENT_TOPIC);
    expect(evt?.inputs.filter((i) => i.indexed).map((i) => i.name)).toEqual([
      "guid",
      "fromAddress",
    ]);
    const derived = layerzeroDef.events?.find((e) => e.slug === "oft-sent");
    expect(derived?.contract).toBe("oft");
    expect(derived?.eventName).toBe("OFTSent");
  });

  it("lzTokenFee defaults to 0 and is advanced; nativeFee and refundAddress are required", () => {
    const s = action("oft-send");
    const lz = s.inputs.find((i) => i.name === "lzTokenFee");
    expect(lz?.default).toBe("0");
    expect(lz?.advanced).toBe(true);
    for (const name of ["nativeFee", "refundAddress"]) {
      const inp = s.inputs.find((i) => i.name === name);
      expect(inp?.default, name).toBeUndefined();
      expect(inp?.advanced, name).toBeUndefined();
    }
  });

  // The value field is wei on this action and ether on every other payable
  // action in the registry, so its label is the one thing standing between
  // the user and a 10^18 mistake. Checked through the same plugin-action
  // builder the editor uses, not through the override object.
  it("labels the send's value field as wei, with the quote reference in its help", () => {
    const plugin = protocolActionToPluginAction(
      layerzeroDef,
      action("oft-send")
    );
    const field = plugin.configFields.find(
      (f) => "key" in f && f.key === "ethValue"
    );
    expect(field).toBeDefined();
    if (!(field && "key" in field)) {
      throw new Error("ethValue field missing");
    }
    expect(field.type).toBe("protocol-eth-value");
    expect(field.label).toBe("Messaging Fee (wei)");
    expect(field.label).not.toMatch(/ETH Value/);
    expect(field.placeholder).toBe("0");
    expect(field.helpTip).toContain("fee.nativeFee");
    expect(field.helpTip).toContain("Native Fee (wei)");
    expect(field.docUrl).toBe(LAYERZERO_OFT_DOCS);
    // Ten ABI inputs, so the value is opt-in at the form level the way it
    // is for every payable action with arguments. Whether it is present at
    // runtime is the OFT's business (it reverts on a mismatch).
    expect(field.required).toBe(false);
  });

  it("quote-oft has seven inputs and three named tuple outputs", () => {
    const q = action("oft-quote-oft");
    expect(q.inputs).toHaveLength(7);
    expect(q.outputs?.map((o) => o.name)).toEqual([
      "oftLimit",
      "oftFeeDetails",
      "oftReceipt",
    ]);
  });

  it("extraOptions defaults to a Type 3 executor option blob and is advanced", () => {
    for (const slug of ["oft-quote-send", "oft-quote-oft"]) {
      const inp = action(slug).inputs.find((i) => i.name === "extraOptions");
      expect(inp?.default, slug).toBe(DEFAULT_EXTRA_OPTIONS);
      expect(inp?.advanced, slug).toBe(true);
    }
    expect(DEFAULT_EXTRA_OPTIONS).toBe(
      "0x00030100110100000000000000000000000000030d40"
    );
  });

  // Asserting the registered kind alone would pass against a padAddressToBytes
  // that returns its input unchanged, so each case applies the function the
  // registry hands back rather than trusting the label on it.
  it("pads the recipient of both quotes and the send to bytes32", () => {
    const address = "0x1111111111111111111111111111111111111111";
    const padded = `0x${"0".repeat(24)}${address.slice(2)}`;

    for (const slug of ["oft-quote-send", "oft-quote-oft", "oft-send"]) {
      expect(getEncodeTransformKind("layerzero", slug, "to")).toBe(
        "padAddressToBytes"
      );

      const transform = getEncodeTransform("layerzero", slug, "to");
      expect(transform, `${slug}/to has no registered transform`).toBeDefined();

      const result = transform?.(address);
      expect(result, slug).toBe(padded);
      // 0x plus one 32-byte word: the width quoteSend's bytes32 field needs.
      expect(result, slug).toHaveLength(66);

      // A template reference is left for the executor to resolve, so an
      // unresolved value is not padded into a malformed address.
      expect(transform?.("{{@node1:Trigger.recipient}}"), slug).toBe(
        "{{@node1:Trigger.recipient}}"
      );
    }
  });

  // Same discipline as the pad test above: apply the function the registry
  // hands back and check the number it returns. A registration that pointed
  // at an identity function would pass a kind-only assertion and send
  // 10^18 times the fee.
  it("converts the send's value field from wei to ether, and nothing else", () => {
    expect(getEncodeTransformKind("layerzero", "oft-send", "ethValue")).toBe(
      "weiToEther"
    );
    const transform = getEncodeTransform("layerzero", "oft-send", "ethValue");
    expect(transform).toBeDefined();

    // The live quote observed on 2026-09-15 for the chain-1 USDT0 lane.
    expect(transform?.("218756042576226")).toBe("0.000218756042576226");
    // Round-trips exactly: parseEther of the output is the wei that went in.
    expect(ethers.parseEther(transform?.("218756042576226") ?? "")).toBe(
      BigInt("218756042576226")
    );
    expect(transform?.("1")).toBe("0.000000000000000001");
    expect(transform?.(OFT_SEND_FIXTURE_FEE_WEI)).toBe("0.01");
    // A template is left for the executor to resolve after the quote runs.
    expect(transform?.("{{@quote:OFT Quote Send.fee.nativeFee}}")).toBe(
      "{{@quote:OFT Quote Send.fee.nativeFee}}"
    );
    // Ether typed into the wei field is refused rather than sent as 0.01
    // wei (which would revert on chain) or misread as 0.01 ether.
    expect(() => transform?.("0.01")).toThrow(/integer wei/);

    // The ABI inputs of the send keep their raw values: nativeFee is a
    // uint256 in wei on the wire and must not be converted. Only `to` has
    // a transform, and it is the pad.
    for (const inp of action("oft-send").inputs) {
      const kind = getEncodeTransformKind("layerzero", "oft-send", inp.name);
      expect(kind, inp.name).toBe(
        inp.name === "to" ? "padAddressToBytes" : undefined
      );
    }
    // And no other LayerZero action converts its value field.
    const weiToEtherEntries = listEncodeTransforms().filter(
      (t) => t.protocolSlug === "layerzero" && t.kind === "weiToEther"
    );
    expect(weiToEtherEntries).toEqual([
      {
        protocolSlug: "layerzero",
        actionSlug: "oft-send",
        inputName: "ethValue",
        kind: "weiToEther",
      },
    ]);
  });

  // The fixture is the one place the two fee fields are typed by hand, so
  // pin the rule the contract enforces (msg.value == fee.nativeFee) and the
  // unit the field takes (wei, an integer string).
  it("binds the same wei fee to nativeFee and to the value field in the fixture", () => {
    const fixture = layerzeroDef.testData?.["1"]?.actions["oft-send"];
    expect(fixture).toBeDefined();
    expect(fixture?.nativeFee).toBe(OFT_SEND_FIXTURE_FEE_WEI);
    expect(fixture?.ethValue).toBe(OFT_SEND_FIXTURE_FEE_WEI);
    expect(OFT_SEND_FIXTURE_FEE_WEI).toMatch(/^\d+$/);
    expect(fixture?.lzTokenFee).toBe("0");
    // The fabricated allowance equals the send amount exactly, so the send
    // drains it to zero and the later USDT approve (which rejects
    // non-zero -> non-zero) can run. See the setup note in layerzero.ts.
    const setup = layerzeroDef.testData?.["1"]?.setup;
    const fabricated = setup?.fabricatedApprovals?.find(
      (a) => a.token === "USDT"
    );
    expect(fabricated?.human).toBe("1");
    expect(fixture?.amountLD).toBe("1000000");
    expect(setup?.requiredTokens).toContainEqual({
      symbol: "USDT",
      human: "1",
    });
  });

  it("derives the send before the approve, which the fixture ordering relies on", () => {
    // Writes run in registry order. oft-send lives on the `oft` contract
    // and oft-approve on `oftToken`, and the fixture fabricates exactly the
    // allowance the send consumes so the approve then runs from zero.
    // Swapping the contract order in the definition would make the approve
    // revert on USDT's non-zero -> non-zero rule; this is the test that says
    // why.
    const slugs = layerzeroDef.actions.map((a) => a.slug);
    expect(slugs.indexOf("oft-send")).toBeLessThan(
      slugs.indexOf("oft-approve")
    );
  });

  it("every input carries an allowed docUrl", () => {
    for (const a of layerzeroDef.actions) {
      for (const inp of a.inputs) {
        expect(inp.docUrl, `${a.slug}/${inp.name}`).toBeDefined();
        expect(
          ALLOWED_DOC_URLS.has(inp.docUrl ?? ""),
          `${a.slug}/${inp.name}`
        ).toBe(true);
      }
    }
  });

  it("the approve write is not payable and declares no value-field label", () => {
    expect(action("oft-approve").payable).toBeUndefined();
    expect(action("oft-approve").payableValue).toBeUndefined();
  });

  // Chain 1's reference token is USDT, whose approve returns no data. The
  // write path decodes the preflight staticCall's return against these
  // outputs (lib/web3/chain-adapter/evm.ts), so a bool declaration throws
  // BAD_DATA and the approve never broadcasts. Empty outputs decode both an
  // absent return and the 32 bytes a conforming token sends.
  it("declares approve with no outputs so USDT's empty return decodes", () => {
    const iface = new ethers.Interface(layerzeroErc20Abi);
    const bool32 = ethers.zeroPadValue("0x01", 32);

    expect(iface.getFunction("approve")?.outputs).toHaveLength(0);
    expect(() => iface.decodeFunctionResult("approve", "0x")).not.toThrow();
    expect(() => iface.decodeFunctionResult("approve", bool32)).not.toThrow();
  });

  it("getConfig defaults configType to the ULN config", () => {
    const inp = action("endpoint-get-config").inputs.find(
      (i) => i.name === "configType"
    );
    expect(inp?.default).toBe("2");
  });

  it("publishes the endpoint IDs for every chain in the endpoint map", () => {
    for (const chain of Object.keys(
      layerzeroDef.contracts.endpointV2.addresses
    )) {
      expect(LAYERZERO_EIDS[chain], chain).toBeDefined();
    }
    expect(LAYERZERO_EIDS["1"]).toBe(30_101);
    expect(LAYERZERO_EIDS["8453"]).toBe(30_184);
    expect(LAYERZERO_EIDS["42161"]).toBe(30_110);
    expect(LAYERZERO_EIDS["10"]).toBe(30_111);
    expect(LAYERZERO_EIDS["137"]).toBe(30_109);
    expect(LAYERZERO_EIDS["11155111"]).toBe(40_161);
    expect(LAYERZERO_EIDS["84532"]).toBe(40_245);
  });

  it("names every chain in the endpoint map in the destination help text", () => {
    // Names restated here rather than imported, so a typo in the source list
    // fails instead of being mirrored. A chain added to LAYERZERO_EIDS without
    // a name lands in the help text as a bare chain ID, which this catches.
    const names: Record<string, string> = {
      "1": "Ethereum",
      "8453": "Base",
      "42161": "Arbitrum One",
      "10": "Optimism",
      "137": "Polygon",
      "11155111": "Ethereum Sepolia",
      "84532": "Base Sepolia",
    };
    const tip = action("oft-quote-send").inputs.find(
      (i) => i.name === "dstEid"
    )?.helpTip;

    expect(tip).toBeDefined();
    for (const [chainId, eid] of Object.entries(LAYERZERO_EIDS)) {
      expect(tip, chainId).toContain(`${names[chainId]} ${eid}`);
    }
  });

  it("registers in the protocol registry and is retrievable", () => {
    registerProtocol(layerzeroDef);
    expect(getProtocol("layerzero")?.slug).toBe("layerzero");
  });
});
