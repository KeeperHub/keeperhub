import { ethers } from "ethers";
import { describe, expect, it } from "vitest";
import { isForwarder, unwrapForwardedCall } from "@/lib/policy/safe-unwrap";

const SAFE = "0x1111111111111111111111111111111111111111";
const POOL = "0xa238dd80c259a72e81d7e4664a9801593f98d1c5";
const ASSET = "0x2222222222222222222222222222222222222222";

const pool = new ethers.Interface([
  "function borrow(address asset, uint256 amount, uint256 rateMode, uint16 referral, address onBehalfOf)",
]);

const safe = new ethers.Interface([
  "function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures)",
  "function execTransactionFromModule(address to, uint256 value, bytes data, uint8 operation)",
]);

const roles = new ethers.Interface([
  "function execTransactionWithRole(address to, uint256 value, bytes data, uint8 operation, bytes32 roleKey, bool shouldRevert)",
]);

const innerBorrow = pool.encodeFunctionData("borrow", [
  ASSET,
  BigInt(1),
  BigInt(2),
  0,
  SAFE,
]);

const wrappers: Record<string, string> = {
  "a Safe execTransaction": safe.encodeFunctionData("execTransaction", [
    POOL,
    BigInt(7),
    innerBorrow,
    0,
    BigInt(0),
    BigInt(0),
    BigInt(0),
    ethers.ZeroAddress,
    ethers.ZeroAddress,
    "0x",
  ]),
  "a Safe module call": safe.encodeFunctionData("execTransactionFromModule", [
    POOL,
    BigInt(7),
    innerBorrow,
    0,
  ]),
  "a Roles modifier call": roles.encodeFunctionData("execTransactionWithRole", [
    POOL,
    BigInt(7),
    innerBorrow,
    0,
    ethers.ZeroHash,
    true,
  ]),
};

describe.each(Object.entries(wrappers))("%s", (_name, data) => {
  it("is recognised as forwarding to somewhere else", () => {
    expect(isForwarder(data)).toBe(true);
  });

  it("reveals the address the call really reaches", () => {
    // Without this, routing through a Safe is a way around every rule about a
    // target: the signer only ever sees the Safe.
    const inner = unwrapForwardedCall(data);
    expect(inner?.to.toLowerCase()).toBe(POOL);
    expect(inner?.selector).toBe(innerBorrow.slice(0, 10));
    expect(inner?.valueWei).toBe("7");
  });
});

describe("an ordinary call", () => {
  const erc20 = new ethers.Interface([
    "function transfer(address to, uint256 amount)",
  ]);
  const plain = erc20.encodeFunctionData("transfer", [SAFE, BigInt(5)]);

  it("is not treated as a forwarder", () => {
    expect(isForwarder(plain)).toBe(false);
    expect(unwrapForwardedCall(plain)).toBeNull();
  });

  it.each([[undefined], [null], ["0x"], ["0xdeadbeef"]])(
    "unwraps %s to nothing rather than throwing",
    (data) => {
      expect(unwrapForwardedCall(data)).toBeNull();
    }
  );
});
