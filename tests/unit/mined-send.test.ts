import { describe, expect, it } from "vitest";
import { isMinedSend, MINED_SEND_KIND, minedSend } from "@/lib/web3/mined-send";

describe("minedSend", () => {
  it("wraps a mined result with its hash", () => {
    const sent = minedSend("0xhash", { success: true as const });

    expect(sent).toEqual({
      kind: MINED_SEND_KIND,
      hash: "0xhash",
      result: { success: true },
    });
    expect(isMinedSend(sent)).toBe(true);
  });

  it("does not mistake a step result for a mined send", () => {
    expect(isMinedSend({ success: false, error: "reverted" })).toBe(false);
    expect(isMinedSend({ success: true, transactionHash: "0xhash" })).toBe(
      false
    );
  });
});
