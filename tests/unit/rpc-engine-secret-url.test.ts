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
    const masked = "https://eth-mainnet.example.com/••••";

    expect(url.masked).toBe(masked);
    expect(String(url)).toBe(masked);
    expect(`${url}`).toBe(masked);
    expect(JSON.stringify({ url })).toBe(JSON.stringify({ url: masked }));
    expect(inspect({ url })).not.toContain("abcdef0123456789");
  });

  it("masks query strings and credentials", () => {
    expect(
      SecretUrl.parse("https://rpc.example.com?apikey=secret").masked
    ).toBe("https://rpc.example.com/••••");
    expect(SecretUrl.parse("https://user:pass@rpc.example.com").masked).toBe(
      "https://rpc.example.com/••••"
    );
  });

  it("leaves a bare host unmasked", () => {
    expect(SecretUrl.parse("https://rpc.example.com/").masked).toBe(
      "https://rpc.example.com"
    );
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
