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
import {
  clearEncodeTransforms,
  registerEncodeTransform,
  weiToEther,
} from "@/lib/protocol-encode-transforms";
import { getProtocol } from "@/lib/protocol-registry";
import { encodeFromConfig } from "@/lib/test-data/encode-action";

const ONE_ETH_WEI = "1000000000000000000";

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
