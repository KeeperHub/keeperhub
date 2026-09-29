import { DrizzleQueryError } from "drizzle-orm/errors";
import { describe, expect, it } from "vitest";
import { describeErrorCauses, MAX_CAUSE_DEPTH } from "@/lib/errors/cause-chain";

function connectError(
  code: string,
  address: string,
  port: number
): Error & { code: string; address: string; port: number } {
  return Object.assign(new Error(`connect ${code} ${address}:${port}`), {
    code,
    address,
    port,
  });
}

// Shape of the error Node raises when every address of a multi-address
// connect fails: an AggregateError with an empty message, the first
// attempt's code, and one entry per attempted address.
function familyAutoselectFailure(): AggregateError & { code: string } {
  const error = new AggregateError(
    [
      connectError("ETIMEDOUT", "192.0.2.10", 5432),
      connectError("ENETUNREACH", "2001:db8::1", 5432),
    ],
    "all connection attempts failed"
  );
  error.message = "";
  return Object.assign(error, { code: "ETIMEDOUT" });
}

describe("describeErrorCauses", () => {
  it("returns an empty string when the error has no cause", () => {
    expect(describeErrorCauses(new Error("boom"))).toBe("");
    expect(describeErrorCauses("boom")).toBe("");
    expect(describeErrorCauses(undefined)).toBe("");
    expect(describeErrorCauses(null)).toBe("");
  });

  it("surfaces the driver error behind a drizzle query error", () => {
    const error = new DrizzleQueryError(
      'update "workflow_executions" set "status" = $1',
      ["running"],
      familyAutoselectFailure()
    );

    expect(describeErrorCauses(error)).toBe(
      "AggregateError ETIMEDOUT [ETIMEDOUT 192.0.2.10:5432 | ENETUNREACH 2001:db8::1:5432]"
    );
  });

  it("joins nested causes from outermost to innermost", () => {
    const inner = Object.assign(new Error("terminating connection"), {
      code: "57P01",
    });
    const middle = new Error("query failed", { cause: inner });
    const outer = new Error("wrapper", { cause: middle });

    expect(describeErrorCauses(outer)).toBe(
      "Error: query failed <- Error 57P01: terminating connection"
    );
  });

  it(`stops after ${MAX_CAUSE_DEPTH} levels`, () => {
    let error: Error = new Error("level 10");
    for (let level = 9; level >= 0; level--) {
      error = new Error(`level ${level}`, { cause: error });
    }

    const parts = describeErrorCauses(error).split(" <- ");

    expect(parts).toHaveLength(MAX_CAUSE_DEPTH);
    expect(parts[0]).toBe("Error: level 1");
  });

  it("stops on a cause cycle", () => {
    const first = new Error("first");
    const second = new Error("second", { cause: first });
    first.cause = second;

    expect(describeErrorCauses(first)).toBe("Error: second");
  });

  it("describes a non-Error cause", () => {
    expect(
      describeErrorCauses(new Error("wrapper", { cause: "socket hang up" }))
    ).toBe("socket hang up");
  });

  it("keeps only the first line of a multi-line cause message", () => {
    const cause = new Error("Failed query: select 1\nparams: secret-value");

    expect(describeErrorCauses(new Error("wrapper", { cause }))).toBe(
      "Error: Failed query: select 1"
    );
  });

  it("scrubs RPC provider keys out of cause messages", () => {
    const cause = new Error(
      "request to https://eth-mainnet.g.alchemy.com/v2/abcdefghijklmnopqrstuvwxyz123456 failed"
    );

    const described = describeErrorCauses(new Error("wrapper", { cause }));

    expect(described).not.toContain("abcdefghijklmnopqrstuvwxyz123456");
    expect(described).toContain(
      "https://eth-mainnet.g.alchemy.com/v2/[REDACTED]"
    );
  });
});
