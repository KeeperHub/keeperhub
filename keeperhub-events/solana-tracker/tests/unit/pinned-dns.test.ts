import dns from "node:dns";
import { describe, expect, it } from "vitest";
import { pinEndpointHosts } from "../../src/rpc-route/pinned-dns";
import { parseRoute } from "../../src/rpc-route/route";

function lookup(hostname: string): Promise<string> {
  return new Promise((resolve, reject) => {
    dns.lookup(hostname, {}, (error, address) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(String(address));
    });
  });
}

describe("pinEndpointHosts", () => {
  it("answers a pinned host only with its vetted addresses", async () => {
    pinEndpointHosts([
      { url: "https://org-node.example/key", addresses: ["203.0.113.10"] },
    ]);

    await expect(lookup("org-node.example")).resolves.toBe("203.0.113.10");
    await expect(lookup("ORG-NODE.example")).resolves.toBe("203.0.113.10");
  });

  it("leaves other hosts to ordinary resolution", async () => {
    pinEndpointHosts([
      { url: "https://org-node.example/key", addresses: ["203.0.113.10"] },
    ]);

    await expect(lookup("localhost")).resolves.not.toBe("203.0.113.10");
  });

  it("drops a host once its endpoint is no longer in use", async () => {
    pinEndpointHosts([
      { url: "https://org-node.example/key", addresses: ["203.0.113.10"] },
    ]);
    pinEndpointHosts([]);

    await expect(lookup("org-node.example")).rejects.toThrow();
  });
});

describe("parseRoute", () => {
  it("refuses an organization endpoint without vetted addresses", () => {
    expect(
      parseRoute({
        key: "k",
        organizationId: "org-1",
        chainId: 101,
        transport: "http",
        primary: { url: "https://org-node.example/key", origin: "org" },
      }),
    ).toBeNull();
  });
});
