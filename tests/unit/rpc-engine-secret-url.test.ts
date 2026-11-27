import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { SecretUrl } from "@/lib/rpc/engine/secret-url";
import { RpcTransport } from "@/lib/rpc/engine/types";

const KEYED = "https://eth-mainnet.example.com/v2/abcdef0123456789abcdef";

describe("SecretUrl", () => {
  it("reveals the original URL only on request", () => {
    expect(SecretUrl.parse(KEYED).reveal()).toBe(KEYED);
  });

  it("masks the URL in every string conversion", () => {
    const url = SecretUrl.parse(KEYED);
    const masked = "https://••••";

    expect(url.masked).toBe(masked);
    expect(String(url)).toBe(masked);
    expect(`${url}`).toBe(masked);
    expect(JSON.stringify({ url })).toBe(JSON.stringify({ url: masked }));
    expect(inspect({ url })).not.toContain("example");
  });

  it.each([
    ["a key in the path", "https://eth-mainnet.g.example.com/v2/k3yk3yk3y"],
    ["a key in the query", "https://rpc.example.com/?dkey=k3yk3yk3y"],
    ["credentials", "https://user:k3yk3yk3y@rpc.example.com"],
    [
      "an endpoint name in the subdomain",
      "wss://k3yk3yk3y.example.com:8546/ws",
    ],
    ["an IP address", "https://203.0.113.7:8545/k3yk3yk3y"],
  ])("keeps nothing but the scheme for %s", (_case, raw) => {
    const url = SecretUrl.parse(raw);
    expect(url.masked).toMatch(/^(https?|wss?):\/\/••••$/);
    expect(url.masked).not.toContain("k3y");
    expect(url.masked).not.toContain("example");
    expect(url.masked).not.toContain("203.0.113.7");
  });

  it("derives the transport from the scheme", () => {
    expect(SecretUrl.parse("https://a.example.com").transport).toBe(
      RpcTransport.HTTP
    );
    expect(SecretUrl.parse("http://a.example.com").transport).toBe(
      RpcTransport.HTTP
    );
    expect(SecretUrl.parse("wss://a.example.com").transport).toBe(
      RpcTransport.WSS
    );
    expect(SecretUrl.parse("ws://a.example.com").transport).toBe(
      RpcTransport.WSS
    );
  });

  it("rejects unsupported schemes and malformed input without echoing it", () => {
    expect(() => SecretUrl.parse("ftp://a.example.com/key")).toThrow(
      "Unsupported RPC URL scheme ftp"
    );
    expect(() => SecretUrl.parse("not a url secret")).toThrow(
      "Invalid RPC URL"
    );
  });

  it("gives equal fingerprints for equal URLs and different ones otherwise", () => {
    expect(SecretUrl.parse(KEYED).fingerprint).toBe(
      SecretUrl.parse(` ${KEYED} `).fingerprint
    );
    expect(SecretUrl.parse(KEYED).fingerprint).not.toBe(
      SecretUrl.parse(`${KEYED}x`).fingerprint
    );
    expect(SecretUrl.parse(KEYED).fingerprint).not.toContain("abcdef0123");
  });

  it("treats empty optional values as absent", () => {
    expect(SecretUrl.parseOptional(null)).toBeUndefined();
    expect(SecretUrl.parseOptional(undefined)).toBeUndefined();
    expect(SecretUrl.parseOptional("  ")).toBeUndefined();
    expect(SecretUrl.parseOptional(KEYED)?.reveal()).toBe(KEYED);
  });
});
