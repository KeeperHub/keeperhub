/**
 * The golden-calldata and on-chain harnesses must charge msg.value through
 * the same ethValue transform the runtime applies. If they diverge, every
 * tier below them agrees with itself and disagrees with production by a
 * factor of 10^18 - silently, because the calldata is identical and only
 * the value differs.
 */

import { parseEther } from "ethers";
import { afterEach, describe, expect, it } from "vitest";
import "@/protocols";
import { PAYER_PLACEHOLDER } from "@/lib/execute/protocol-payer";
import {
  clearEncodeTransforms,
  registerEncodeTransform,
  weiToEther,
} from "@/lib/protocol-encode-transforms";
import { getProtocol } from "@/lib/protocol-registry";
import {
  encodeBoundAction,
  encodeFromConfig,
} from "@/lib/test-data/encode-action";
import { OFT_SEND_FIXTURE_FEE_WEI } from "@/protocols/layerzero";

const ONE_ETH_WEI = "1000000000000000000";
const WALLET = "0x1111111111111111111111111111111111111111";

function layerzeroSend() {
  const protocol = getProtocol("layerzero");
  if (!protocol) {
    throw new Error("layerzero protocol not registered");
  }
  const action = protocol.actions.find((a) => a.slug === "oft-send");
  if (!action) {
    throw new Error("layerzero/oft-send action not registered");
  }
  return { protocol, action };
}

// Runs before the afterEach below clears the registry, so this sees the
// production registration rather than one the test made. It is the only
// case in this file that does, and it is what proves the eager entry in
// lib/protocol-encode-transforms.ts reaches the harness.
describe("encodeFromConfig: layerzero/oft-send (production registration)", () => {
  it("charges the fixture's wei fee as msg.value and encodes the same wei as fee.nativeFee", () => {
    const { protocol, action } = layerzeroSend();
    const encoded = encodeBoundAction(protocol, action, "1", WALLET);

    // msg.value is the fixture's integer wei, not 10^18 times it.
    expect(encoded.value).toBe(BigInt(OFT_SEND_FIXTURE_FEE_WEI));

    // And the ABI-encoded fee argument carries the identical number: the
    // OFT reverts with NotEnoughNative when the two differ, so a harness
    // that got either side wrong would fail on chain rather than here.
    const decoded = encoded.iface.decodeFunctionData("send", encoded.data);
    const fee = decoded[1] as { nativeFee: bigint; lzTokenFee: bigint };
    expect(fee.nativeFee).toBe(encoded.value);
    expect(fee.lzTokenFee).toBe(BigInt(0));
    // The payer slot carries the caller's wallet, keeping the golden
    // calldata byte-identical to when refundAddress was a bound input.
    expect(decoded[2]).toBe(WALLET);
    // `to` is the wallet, padded to bytes32 by the transform.
    const sendParam = decoded[0] as { to: string; dstEid: bigint };
    expect(sendParam.to).toBe(`0x${"0".repeat(24)}${WALLET.slice(2)}`);
    expect(sendParam.dstEid).toBe(BigInt(30_110));

    // Ether typed where wei belongs is refused, not sent as 0.01 wei (a
    // certain on-chain revert) or 0.01 ether. With fromInput the wei-typed
    // field IS the nativeFee argument, so it is ethers' uint256 arg
    // encoder that refuses "0.01" - upstream of the value selection and
    // transform, which is exactly the order the runtime's arg validation
    // would refuse it too. Same `it` as above on purpose: this file's
    // afterEach clears the registry, so a second test would run against
    // an empty one and fail on the missing pad instead.
    expect(() =>
      encodeFromConfig(protocol, action, "1", {
        contractAddress: protocol.contracts.oft.addresses["1"],
        dstEid: "30110",
        to: WALLET,
        amountLD: "1000000",
        minAmountLD: "990000",
        nativeFee: "0.01",
        lzTokenFee: "0",
      })
    ).toThrow(/Cannot convert 0\.01 to a BigInt/);

    // A legacy separate ethValue that disagrees with nativeFee is refused
    // at source selection, before the value transform ever runs; an equal
    // one is still accepted.
    expect(() =>
      encodeFromConfig(protocol, action, "1", {
        contractAddress: protocol.contracts.oft.addresses["1"],
        dstEid: "30110",
        to: WALLET,
        amountLD: "1000000",
        minAmountLD: "990000",
        nativeFee: OFT_SEND_FIXTURE_FEE_WEI,
        lzTokenFee: "0",
        ethValue: "1",
      })
    ).toThrow(/takes its value from "nativeFee"/);
    expect(
      encodeFromConfig(protocol, action, "1", {
        contractAddress: protocol.contracts.oft.addresses["1"],
        dstEid: "30110",
        to: WALLET,
        amountLD: "1000000",
        minAmountLD: "990000",
        nativeFee: OFT_SEND_FIXTURE_FEE_WEI,
        lzTokenFee: "0",
        ethValue: OFT_SEND_FIXTURE_FEE_WEI,
      }).value
    ).toBe(BigInt(OFT_SEND_FIXTURE_FEE_WEI));
  });
});

describe("encodeFromConfig: payer arg position", () => {
  // Re-register the transform the production registration provided: the
  // file-level afterEach clears the encode-transform registry after the
  // first describe, which is the only case asserted against it.
  function oftSendConfig() {
    const { protocol, action } = layerzeroSend();
    registerEncodeTransform(
      "layerzero",
      "oft-send",
      "ethValue",
      weiToEther,
      "weiToEther"
    );
    return {
      protocol,
      action,
      config: {
        contractAddress: protocol.contracts.oft.addresses["1"],
        dstEid: "30110",
        // Pre-padded: the padAddressToBytes transform cleared with the
        // registry and is not exported for re-registration.
        to: `0x${"0".repeat(24)}${WALLET.slice(2)}`,
        amountLD: "1000000",
        minAmountLD: "990000",
        nativeFee: OFT_SEND_FIXTURE_FEE_WEI,
        lzTokenFee: "0",
      },
    };
  }

  it("encodes the placeholder when no payerAddress is given", () => {
    const { protocol, action, config } = oftSendConfig();
    const encoded = encodeFromConfig(protocol, action, "1", config);
    const decoded = encoded.iface.decodeFunctionData("send", encoded.data);
    expect(decoded[2]).toBe(PAYER_PLACEHOLDER);
  });

  it("encodes the given payerAddress over any config key of the same name", () => {
    const { protocol, action, config } = oftSendConfig();
    const encoded = encodeFromConfig(
      protocol,
      action,
      "1",
      {
        ...config,
        // Ignored: the payer arg comes from payerAddress, not config.
        refundAddress: "0x2222222222222222222222222222222222222222",
      },
      WALLET
    );
    const decoded = encoded.iface.decodeFunctionData("send", encoded.data);
    expect(decoded[2]).toBe(WALLET);
  });
});

function wrappedWrap() {
  const protocol = getProtocol("wrapped");
  if (!protocol) {
    throw new Error("wrapped protocol not registered");
  }
  const action = protocol.actions.find((a) => a.slug === "wrap");
  if (!action) {
    throw new Error("wrapped/wrap action not registered");
  }
  return { protocol, action };
}

afterEach(() => {
  clearEncodeTransforms();
});

describe("encodeFromConfig: ethValue transforms", () => {
  it("reads ethValue as ether when no transform is registered", () => {
    const { protocol, action } = wrappedWrap();
    const encoded = encodeFromConfig(protocol, action, "1", {
      ethValue: "0.01",
    });
    expect(encoded.value).toBe(parseEther("0.01"));
  });

  it("applies a registered weiToEther transform before parseEther", () => {
    const { protocol, action } = wrappedWrap();
    registerEncodeTransform(
      "wrapped",
      "wrap",
      "ethValue",
      weiToEther,
      "weiToEther"
    );

    const encoded = encodeFromConfig(protocol, action, "1", {
      ethValue: ONE_ETH_WEI,
    });

    expect(encoded.value).toBe(BigInt(ONE_ETH_WEI));
  });

  it("would send 10^18x without the transform, which is what this guards", () => {
    // The failure mode stated explicitly: the same raw wei string with no
    // transform registered. parseEther reads it as ether, so the harness
    // would charge 1e36 wei while the runtime charges 1e18. Nothing about
    // the calldata changes, which is why only an assertion on `value`
    // catches it.
    const { protocol, action } = wrappedWrap();
    const encoded = encodeFromConfig(protocol, action, "1", {
      ethValue: ONE_ETH_WEI,
    });
    expect(encoded.value).toBe(BigInt(ONE_ETH_WEI) * BigInt(ONE_ETH_WEI));
  });

  it("fails loudly on a value for a definition the registry does not know", () => {
    // The harness now runs the shared helper, which resolves the action
    // through the registry. A synthetic definition handed in without being
    // registered used to have its conversion silently skipped and its raw
    // value parsed as ether; now it throws, so a fixture cannot be checked
    // against a number production would never send.
    const { protocol, action } = wrappedWrap();
    const unregistered = { ...protocol, slug: "zz-not-registered" };
    expect(() =>
      encodeFromConfig(unregistered, action, "1", { ethValue: "0.01" })
    ).toThrow(/Refusing to send a payable value/);
    // Without a value there is nothing to convert, so it still encodes.
    expect(encodeFromConfig(unregistered, action, "1", {}).value).toBe(
      BigInt(0)
    );
  });

  it("leaves an unresolved template for the executor", () => {
    const { protocol, action } = wrappedWrap();
    registerEncodeTransform(
      "wrapped",
      "wrap",
      "ethValue",
      weiToEther,
      "weiToEther"
    );
    // weiToEther passes templates through; parseEther then rejects them, so
    // assert the transform did not throw on the way past rather than
    // asserting a value the harness never computes for a template.
    expect(() =>
      encodeFromConfig(protocol, action, "1", {
        ethValue: "{{@quote:Quote.fee.nativeFee}}",
      })
    ).toThrow();
  });
});

/**
 * The calldata fixtures are the fourth consumer of a stored array input, and
 * they read it through the same helper as the editor, the validator and the
 * steps. A legacy value that encodes here encodes in production.
 */
describe("encodeFromConfig: array inputs", () => {
  function lidoClaimWithdrawals() {
    const protocol = getProtocol("lido");
    const action = protocol?.actions.find(
      (a) => a.slug === "claim-withdrawals"
    );
    if (!(protocol && action)) {
      throw new Error("lido/claim-withdrawals not registered");
    }
    return { protocol, action };
  }

  it("encodes a legacy single scalar as a one-item array", () => {
    const { protocol, action } = lidoClaimWithdrawals();

    expect(
      encodeFromConfig(protocol, action, "1", {
        requestIds: "135184",
        hints: "1216",
      }).data
    ).toBe(
      encodeFromConfig(protocol, action, "1", {
        requestIds: '["135184"]',
        hints: '["1216"]',
      }).data
    );
  });

  it("encodes a resolved whole-field reference", () => {
    const { protocol, action } = lidoClaimWithdrawals();

    expect(
      encodeFromConfig(protocol, action, "1", {
        requestIds: '["135184","135185"]',
        hints: '["1216","1217"]',
      }).data
    ).toMatch(/^0x/);
  });
});
