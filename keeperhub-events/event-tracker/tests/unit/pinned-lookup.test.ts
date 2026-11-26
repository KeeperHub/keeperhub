import { describe, expect, it } from "vitest";
import { pinnedLookup } from "../../src/chains/pinned-lookup";
import { parseRpcRoute } from "../../src/chains/rpc-route";

function resolveWith(
  addresses: string[],
  all: boolean,
): Promise<{ error: Error | null; result: unknown }> {
  return new Promise((resolve) => {
    pinnedLookup(addresses)("internal.example", { all }, (error, result) =>
      resolve({ error, result }),
    );
  });
}

describe("pinnedLookup", () => {
  it("answers with the vetted address whatever the host", async () => {
    const { result } = await resolveWith(["203.0.113.10"], false);
    expect(result).toBe("203.0.113.10");
  });

  it("lists every vetted address when asked for all", async () => {
    const { result } = await resolveWith(["203.0.113.10", "2001:db8::1"], true);
    expect(result).toEqual([
      { address: "203.0.113.10", family: 4 },
      { address: "2001:db8::1", family: 6 },
    ]);
  });

  it("refuses to resolve without a vetted address", async () => {
    const { error } = await resolveWith([], false);
    expect(error).not.toBeNull();
  });
});

describe("parseRpcRoute", () => {
  const base = {
    key: "k",
    organizationId: "org-1",
    chainId: 1,
    transport: "wss",
  };

  it("refuses an organization endpoint without vetted addresses", () => {
    expect(
      parseRpcRoute({
        ...base,
        primary: { url: "wss://org-node.example/key", origin: "org" },
      }),
    ).toBeNull();
  });

  it("keeps the vetted addresses of an organization endpoint", () => {
    expect(
      parseRpcRoute({
        ...base,
        primary: {
          url: "wss://org-node.example/key",
          origin: "org",
          addresses: ["203.0.113.10"],
        },
      })?.primary.addresses,
    ).toEqual(["203.0.113.10"]);
  });
});
