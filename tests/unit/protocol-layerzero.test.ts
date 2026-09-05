import { describe, expect, it } from "vitest";
import { getEncodeTransformKind } from "@/lib/protocol-encode-transforms";
import { getProtocol, registerProtocol } from "@/lib/protocol-registry";
import layerzeroDef, {
  DEFAULT_EXTRA_OPTIONS,
  LAYERZERO_CONFIG_DOCS,
  LAYERZERO_DEPLOYMENTS_DOCS,
  LAYERZERO_EIDS,
  LAYERZERO_OFT_DOCS,
  LAYERZERO_PROTOCOL_DOCS,
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
const WRITE_SLUGS = ["oft-approve"];

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

  it("has exactly the twelve accepted actions: eleven reads and one write", () => {
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
      "dstEid",
      "to",
      "amountLD",
      "minAmountLD",
      "extraOptions",
      "composeMsg",
      "oftCmd",
      "payInLzToken",
    ]);
    expect(q.outputs?.map((o) => o.name)).toEqual(["fee"]);
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

  it("registers padAddressToBytes on the recipient of both quote actions", () => {
    expect(getEncodeTransformKind("layerzero", "oft-quote-send", "to")).toBe(
      "padAddressToBytes"
    );
    expect(getEncodeTransformKind("layerzero", "oft-quote-oft", "to")).toBe(
      "padAddressToBytes"
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

  it("the approve write is not payable", () => {
    expect(action("oft-approve").payable).toBeUndefined();
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
