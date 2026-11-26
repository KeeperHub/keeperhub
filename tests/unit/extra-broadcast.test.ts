import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/logging", () => ({ logWarn: vi.fn() }));
const { safeFetch } = vi.hoisted(() => ({ safeFetch: vi.fn() }));
vi.mock("@/lib/safe-fetch", () => ({ safeFetch }));

import { broadcastToExtraRpcs } from "@/lib/web3/extra-broadcast";

const HASH = `0x${"a".repeat(64)}`;

describe("extra URL deliveries", () => {
  beforeEach(() => {
    safeFetch.mockReset();
  });

  it("counts a 3xx as may-have-sent: the endpoint read the signed bytes", async () => {
    safeFetch.mockResolvedValue(
      Response.redirect("https://elsewhere.example", 307)
    );
    const { deliveries } = broadcastToExtraRpcs(
      ["https://extra.example"],
      "0x02",
      HASH,
      1
    );
    expect(await deliveries).toEqual(["unknown"]);
    expect(safeFetch).toHaveBeenCalledWith(
      "https://extra.example",
      expect.objectContaining({ redirect: "manual" })
    );
  });

  it("counts a refused connection as never sent", async () => {
    safeFetch.mockRejectedValue(
      new TypeError("fetch failed", {
        cause: Object.assign(new Error("connect ECONNREFUSED"), {
          code: "ECONNREFUSED",
        }),
      })
    );
    const { deliveries } = broadcastToExtraRpcs(
      ["https://extra.example"],
      "0x02",
      HASH,
      1
    );
    expect(await deliveries).toEqual(["refused"]);
  });
});
