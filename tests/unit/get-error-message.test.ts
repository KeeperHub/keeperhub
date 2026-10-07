import { describe, expect, it } from "vitest";

import { getErrorMessage } from "@/lib/utils";

describe("getErrorMessage", () => {
  it("appends the cause message", () => {
    const error = new TypeError("fetch failed", {
      cause: new Error("connect ECONNREFUSED 203.0.113.10:443"),
    });
    expect(getErrorMessage(error)).toBe(
      "fetch failed: connect ECONNREFUSED 203.0.113.10:443"
    );
  });

  it("lists every address of a failed multi-address connect", () => {
    const error = new TypeError("fetch failed", {
      // biome-ignore lint/suspicious/useErrorMessage: Node's own AggregateError for a failed multi-address connect has an empty message, which is the case under test
      cause: new AggregateError(
        [
          new Error("connect ETIMEDOUT 203.0.113.10:443"),
          new Error("connect ECONNREFUSED 203.0.113.11:443"),
        ],
        ""
      ),
    });
    expect(getErrorMessage(error)).toBe(
      "fetch failed: connect ETIMEDOUT 203.0.113.10:443; connect ECONNREFUSED 203.0.113.11:443"
    );
  });
});
