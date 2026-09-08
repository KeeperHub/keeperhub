import { ethers } from "ethers";
import { describe, expect, it } from "vitest";
import {
  buildCreateProxyCalldata,
  buildSetupCalldata,
  orgSaltNonce,
  parseProxyCreationEvent,
  SAFE_PROXY_FACTORY_ABI,
  SAFE_SETUP_ABI,
  ZERO_ADDRESS,
} from "@/lib/safe/address";
import { getSafeContracts } from "@/lib/safe/contracts";

const EXAMPLE_OWNER = "0x1111111111111111111111111111111111111111";
const SECOND_OWNER = "0x2222222222222222222222222222222222222222";
const ORG_ID = "org_abcdef";
const CHAIN_ID = 8453;
const AT_LEAST_ONE_OWNER_RE = /at least one owner/i;
const THRESHOLD_RE = /threshold/i;
const PROXY_CREATION_NOT_FOUND_RE = /ProxyCreation event not found/;
const UINT128_MAX = BigInt(2) ** BigInt(128);

describe("buildSetupCalldata", () => {
  it("starts with the setup() function selector", () => {
    const iface = new ethers.Interface(SAFE_SETUP_ABI);
    const selector = iface.getFunction("setup")?.selector;
    expect(selector).toBeDefined();

    const calldata = buildSetupCalldata({
      owners: [EXAMPLE_OWNER],
      threshold: 1,
      fallbackHandler: ZERO_ADDRESS,
    });
    expect(calldata.slice(0, 10)).toBe(selector);
  });

  it("round-trips owners, threshold, and fallback handler through the encoder", () => {
    const { compatibilityFallbackHandler } = getSafeContracts(CHAIN_ID);
    const calldata = buildSetupCalldata({
      owners: [EXAMPLE_OWNER, SECOND_OWNER],
      threshold: 2,
      fallbackHandler: compatibilityFallbackHandler,
    });

    const iface = new ethers.Interface(SAFE_SETUP_ABI);
    const decoded = iface.decodeFunctionData("setup", calldata);
    expect(decoded._owners).toEqual([EXAMPLE_OWNER, SECOND_OWNER]);
    expect(decoded._threshold).toBe(BigInt(2));
    expect(decoded.to).toBe(ZERO_ADDRESS);
    expect(decoded.data).toBe("0x");
    expect(ethers.getAddress(decoded.fallbackHandler)).toBe(
      ethers.getAddress(compatibilityFallbackHandler)
    );
    expect(decoded.paymentToken).toBe(ZERO_ADDRESS);
    expect(decoded.payment).toBe(BigInt(0));
    expect(decoded.paymentReceiver).toBe(ZERO_ADDRESS);
  });

  it("rejects empty owners array", () => {
    expect(() =>
      buildSetupCalldata({
        owners: [],
        threshold: 1,
        fallbackHandler: ZERO_ADDRESS,
      })
    ).toThrow(AT_LEAST_ONE_OWNER_RE);
  });

  it("rejects threshold larger than owners count", () => {
    expect(() =>
      buildSetupCalldata({
        owners: [EXAMPLE_OWNER],
        threshold: 2,
        fallbackHandler: ZERO_ADDRESS,
      })
    ).toThrow(THRESHOLD_RE);
  });
});

describe("orgSaltNonce", () => {
  it("is deterministic for the same (org, chain)", () => {
    const a = orgSaltNonce(ORG_ID, CHAIN_ID);
    const b = orgSaltNonce(ORG_ID, CHAIN_ID);
    expect(a).toBe(b);
  });

  it("differs across chains for the same org", () => {
    const base = orgSaltNonce(ORG_ID, 8453);
    const arbitrum = orgSaltNonce(ORG_ID, 42_161);
    expect(base).not.toBe(arbitrum);
  });

  it("differs across orgs on the same chain", () => {
    const first = orgSaltNonce("org_one", CHAIN_ID);
    const second = orgSaltNonce("org_two", CHAIN_ID);
    expect(first).not.toBe(second);
  });

  it("stays within uint128 range", () => {
    const salt = orgSaltNonce(ORG_ID, CHAIN_ID);
    expect(salt).toBeGreaterThanOrEqual(BigInt(0));
    expect(salt).toBeLessThan(UINT128_MAX);
  });
});

describe("buildCreateProxyCalldata", () => {
  it("encodes createProxyWithNonce with the expected selector", () => {
    const iface = new ethers.Interface(SAFE_PROXY_FACTORY_ABI);
    const selector = iface.getFunction("createProxyWithNonce")?.selector;
    expect(selector).toBeDefined();

    const calldata = buildCreateProxyCalldata({
      singleton: "0x29fcB43b46531BcA003ddC8FCB67FFE91900C762",
      initializer: "0x",
      saltNonce: BigInt(123),
    });
    expect(calldata.slice(0, 10)).toBe(selector);
  });
});

describe("parseProxyCreationEvent", () => {
  const factory = "0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67";
  const singleton = "0x29fcB43b46531BcA003ddC8FCB67FFE91900C762";
  const deployedProxy = "0xaaaabbbbccccddddeeeeffff1111222233334444";

  const iface = new ethers.Interface(SAFE_PROXY_FACTORY_ABI);
  const topic = iface.getEvent("ProxyCreation")?.topicHash;

  it("extracts the proxy address emitted by ProxyCreation", () => {
    if (!topic) {
      throw new Error("missing topic");
    }
    const log = iface.encodeEventLog(
      iface.getEvent("ProxyCreation") as ethers.EventFragment,
      [deployedProxy, singleton]
    );
    const receipt = {
      logs: [
        {
          address: factory,
          topics: log.topics,
          data: log.data,
        },
      ],
    } as unknown as ethers.TransactionReceipt;

    expect(parseProxyCreationEvent(receipt, factory)).toBe(
      ethers.getAddress(deployedProxy)
    );
  });

  it("throws when the event is missing", () => {
    const receipt = { logs: [] } as unknown as ethers.TransactionReceipt;
    expect(() => parseProxyCreationEvent(receipt, factory)).toThrow(
      PROXY_CREATION_NOT_FOUND_RE
    );
  });

  it("ignores logs from other contracts with the same topic", () => {
    if (!topic) {
      throw new Error("missing topic");
    }
    const log = iface.encodeEventLog(
      iface.getEvent("ProxyCreation") as ethers.EventFragment,
      [deployedProxy, singleton]
    );
    const receipt = {
      logs: [
        {
          address: "0x9999999999999999999999999999999999999999",
          topics: log.topics,
          data: log.data,
        },
      ],
    } as unknown as ethers.TransactionReceipt;

    expect(() => parseProxyCreationEvent(receipt, factory)).toThrow(
      PROXY_CREATION_NOT_FOUND_RE
    );
  });
});
