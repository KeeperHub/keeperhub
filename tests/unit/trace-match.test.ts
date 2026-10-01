import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  callSelector,
  type FlatCall,
  matchTraceCalls,
  type RawCallFrame,
} from "@/lib/web3/trace-decode";

const ATTACKER = "0x00000000000000000000000000000000000000a1";
const VAULT = "0x00000000000000000000000000000000000000b2";
const ADMIN = "0x00000000000000000000000000000000000000c3";
const IMPL = "0x00000000000000000000000000000000000000d4";
const RECIPIENT = "0x00000000000000000000000000000000000000e5";

// pause() selector 0x8456cb59; transferOwnership(address) 0xf2fde38b.
const PAUSE = "0x8456cb59";
const TRANSFER_OWNERSHIP = "0xf2fde38b";

// A reverted top-level drain attempt on the vault. The EVM rolls back the whole
// subtree, so both the top call and its internal transfer are reverted frames.
// None of this emits an event, which is the point of #2241.
const REVERTED_ROOT: RawCallFrame = {
  type: "CALL",
  from: ATTACKER,
  to: VAULT,
  value: "0x0",
  input: "0x8456cb59",
  error: "execution reverted",
  calls: [
    {
      type: "CALL",
      from: VAULT,
      to: RECIPIENT,
      value: "0xde0b6b3a7640000", // 1 ETH
      input: "0x",
    },
  ],
};

// A successful admin transaction: a privileged transferOwnership on the vault
// that internally delegatecalls an unlogged implementation and makes an
// internal 1 ETH transfer.
const ADMIN_ROOT: RawCallFrame = {
  type: "CALL",
  from: ADMIN,
  to: VAULT,
  value: "0x0",
  input: `${TRANSFER_OWNERSHIP}${"0".repeat(24)}${ATTACKER.slice(2)}`,
  calls: [
    {
      type: "DELEGATECALL",
      from: VAULT,
      to: IMPL,
      value: "0x0",
      input: "0xabcdef01",
    },
    {
      type: "CALL",
      from: VAULT,
      to: RECIPIENT,
      value: "0xde0b6b3a7640000", // 1 ETH
      input: "0x",
    },
  ],
};

describe("callSelector", () => {
  it("returns the 4-byte selector for a call with calldata", () => {
    const call: FlatCall = {
      type: "CALL",
      from: ATTACKER,
      to: VAULT,
      value: "0x0",
      input: "0x8456cb59deadbeef",
      depth: 0,
      reverted: false,
    };
    expect(callSelector(call)).toBe("0x8456cb59");
  });

  it("returns 0x for a value-only frame with no calldata", () => {
    const call: FlatCall = {
      type: "CALL",
      from: VAULT,
      to: RECIPIENT,
      value: "0xde0b6b3a7640000",
      input: "0x",
      depth: 1,
      reverted: false,
    };
    expect(callSelector(call)).toBe("0x");
  });

  it("returns 0x for a CREATE frame even when init code looks like one", () => {
    const call: FlatCall = {
      type: "CREATE",
      from: VAULT,
      to: IMPL,
      value: "0x0",
      input: `${PAUSE}60806040`,
      depth: 1,
      reverted: false,
    };
    expect(callSelector(call)).toBe("0x");
  });
});

describe("matchTraceCalls (issue #2241 trigger matcher)", () => {
  it("matches every frame in a successful tree with an empty filter", () => {
    // top call + delegatecall + internal transfer
    expect(matchTraceCalls(ADMIN_ROOT)).toHaveLength(3);
  });

  it("returns nothing for a null tree", () => {
    expect(matchTraceCalls(null)).toEqual([]);
  });

  it("defaults to success-only, hiding a reverted subtree", () => {
    // The whole REVERTED_ROOT subtree rolled back, so success-only sees none.
    expect(matchTraceCalls(REVERTED_ROOT)).toHaveLength(0);
  });

  it("surfaces a reverted drain attempt and its rolled-back subtree", () => {
    const reverted = matchTraceCalls(REVERTED_ROOT, { status: "reverted" });
    // Both the top call and its internal transfer are reverted frames.
    expect(reverted).toHaveLength(2);
    expect(reverted.every((c) => c.reverted)).toBe(true);
    const top = reverted.find((c) => callSelector(c) === PAUSE);
    expect(top?.to).toBe(VAULT);
  });

  it("matches an internal ETH transfer over a value threshold", () => {
    const matches = matchTraceCalls(ADMIN_ROOT, {
      minValue: BigInt("500000000000000000"), // 0.5 ETH
    });
    expect(matches).toHaveLength(1);
    expect(matches[0].to).toBe(RECIPIENT);
    expect(matches[0].value).toBe("0xde0b6b3a7640000");
  });

  it("excludes a transfer below the value threshold", () => {
    const matches = matchTraceCalls(ADMIN_ROOT, {
      minValue: BigInt("2000000000000000000"), // 2 ETH
    });
    expect(matches).toHaveLength(0);
  });

  it("matches a privileged selector regardless of revert with status any", () => {
    const matches = matchTraceCalls(REVERTED_ROOT, {
      callee: VAULT,
      selector: PAUSE,
      status: "any",
    });
    expect(matches).toHaveLength(1);
    expect(matches[0].reverted).toBe(true);
  });

  it("matches a delegatecall into an unlogged implementation", () => {
    const matches = matchTraceCalls(ADMIN_ROOT, {
      callTypes: ["DELEGATECALL"],
    });
    expect(matches).toHaveLength(1);
    expect(matches[0].to).toBe(IMPL);
    expect(matches[0].type).toBe("DELEGATECALL");
  });

  it("matches transferOwnership by caller and selector", () => {
    const matches = matchTraceCalls(ADMIN_ROOT, {
      caller: ADMIN,
      selector: TRANSFER_OWNERSHIP,
    });
    expect(matches).toHaveLength(1);
    expect(matches[0].from).toBe(ADMIN);
  });

  it("is case-insensitive on addresses and selectors", () => {
    const matches = matchTraceCalls(ADMIN_ROOT, {
      caller: ADMIN.toUpperCase(),
      selector: TRANSFER_OWNERSHIP.toUpperCase(),
    });
    expect(matches).toHaveLength(1);
  });

  it("returns nothing when the callee does not match", () => {
    expect(
      matchTraceCalls(ADMIN_ROOT, { callee: ADMIN, status: "any" })
    ).toHaveLength(0);
  });

  it("is case-insensitive on the callee", () => {
    const matches = matchTraceCalls(ADMIN_ROOT, {
      callee: IMPL.toUpperCase(),
      callTypes: ["DELEGATECALL"],
    });
    expect(matches).toHaveLength(1);
    expect(matches[0].to).toBe(IMPL);
  });

  it("stays quiet on a successful transaction when filtering for reverts", () => {
    // The branch a revert-only trigger depends on: no frame in ADMIN_ROOT
    // reverted, so a "reverted" filter must return nothing rather than
    // falling through to match everything.
    expect(matchTraceCalls(ADMIN_ROOT, { status: "reverted" })).toHaveLength(0);
  });

  it("treats an empty callTypes array as a wildcard", () => {
    // A trigger form serialising an untouched multi-select as [] must behave
    // like an omitted field. [].some() is false, so testing truthiness rather
    // than length would silently match nothing forever.
    expect(matchTraceCalls(ADMIN_ROOT, { callTypes: [] })).toHaveLength(3);
    expect(
      matchTraceCalls(ADMIN_ROOT, { callee: VAULT, callTypes: [] })
    ).toHaveLength(1);
  });

  it("is case-insensitive on callTypes", () => {
    const matches = matchTraceCalls(ADMIN_ROOT, {
      callTypes: ["delegatecall"],
    });
    expect(matches).toHaveLength(1);
    expect(matches[0].type).toBe("DELEGATECALL");
  });

  it("includes a frame exactly at the minValue boundary", () => {
    const oneEth = BigInt("1000000000000000000");
    // The internal transfer moves exactly 1 ETH, so a >= comparison keeps it
    // and a > comparison would drop it.
    expect(matchTraceCalls(ADMIN_ROOT, { minValue: oneEth })).toHaveLength(1);
    expect(
      matchTraceCalls(ADMIN_ROOT, { minValue: oneEth + BigInt(1) })
    ).toHaveLength(0);
  });

  it("surfaces a frame whose value cannot be parsed rather than dropping it", () => {
    // A malformed value is unknown, not zero. Silently failing every threshold
    // would hide exactly the frame worth reviewing.
    const malformed: RawCallFrame = {
      type: "CALL",
      from: VAULT,
      to: RECIPIENT,
      value: "not-a-number",
      input: "0x",
    };
    const matches = matchTraceCalls(malformed, {
      minValue: BigInt("1000000000000000000"),
    });
    expect(matches).toHaveLength(1);
    expect(matches[0].value).toBe("not-a-number");
  });

  it("treats calldata shorter than a selector as carrying none", () => {
    // 2 < length < 10: enough to be non-empty, too short to be a selector.
    const stub: RawCallFrame = {
      type: "CALL",
      from: ADMIN,
      to: VAULT,
      value: "0x0",
      input: "0x8456",
    };
    expect(matchTraceCalls(stub, { selector: PAUSE })).toHaveLength(0);
    expect(callSelector(matchTraceCalls(stub)[0])).toBe("0x");
  });
});

describe("non-calldata frame types (CREATE, CREATE2, SELFDESTRUCT)", () => {
  // flattenCallTree emits these alongside calls. A CREATE carries init code in
  // `input`, whose first four bytes are constructor bytecode, not a selector.
  const DEPLOY_ROOT: RawCallFrame = {
    type: "CALL",
    from: ADMIN,
    to: VAULT,
    value: "0x0",
    input: `${TRANSFER_OWNERSHIP}${"0".repeat(24)}${ATTACKER.slice(2)}`,
    calls: [
      {
        type: "CREATE",
        from: VAULT,
        to: IMPL,
        // Init code whose first four bytes collide with pause().
        input: `${PAUSE}60806040`,
        value: "0xde0b6b3a7640000", // 1 ETH endowment
      },
      {
        type: "SELFDESTRUCT",
        from: VAULT,
        to: RECIPIENT,
        value: "0xde0b6b3a7640000", // 1 ETH swept
        input: "0x",
      },
    ],
  };

  it("never reads init code as a selector", () => {
    const created = matchTraceCalls(DEPLOY_ROOT, { callTypes: ["CREATE"] })[0];
    expect(created.input.startsWith(PAUSE)).toBe(true);
    expect(callSelector(created)).toBe("0x");
  });

  it("does not match a selector filter on a CREATE frame", () => {
    // Without the frame-type gate the endowed CREATE above would answer a
    // pause() trigger, because its init code happens to start with 0x8456cb59.
    const matches = matchTraceCalls(DEPLOY_ROOT, { selector: PAUSE });
    expect(matches).toHaveLength(0);
  });

  it("counts CREATE and SELFDESTRUCT value against a threshold", () => {
    // Both move 1 ETH. A value trigger that hid them would miss a drain, so
    // they are matched and narrowing is left to callTypes.
    const matches = matchTraceCalls(DEPLOY_ROOT, {
      minValue: BigInt("500000000000000000"),
    });
    expect(matches).toHaveLength(2);
    expect(matches.map((c) => c.type).sort()).toEqual([
      "CREATE",
      "SELFDESTRUCT",
    ]);
  });

  it("narrows to plain calls with callTypes", () => {
    const matches = matchTraceCalls(DEPLOY_ROOT, {
      minValue: BigInt("500000000000000000"),
      callTypes: ["CALL"],
    });
    expect(matches).toHaveLength(0);
  });
});
