import { createHash } from "node:crypto";
import { inspect } from "node:util";
import { RpcTransport } from "./types";

/** URL schemes an RPC endpoint may use, keyed as `URL.protocol` reports them. */
const SCHEME_TRANSPORT: Readonly<Record<string, RpcTransport>> = {
  "http:": RpcTransport.HTTP,
  "https:": RpcTransport.HTTP,
  "ws:": RpcTransport.WSS,
  "wss:": RpcTransport.WSS,
};

const MASK = "••••";
const ROOT_PATH = "/";

/** Hash used to identify an endpoint without holding its URL. */
export const FINGERPRINT_HASH = "sha256";
export const FINGERPRINT_ENCODING = "hex";

/**
 * An RPC endpoint URL that may carry a credential in its path or query.
 *
 * Every string conversion (template literals, JSON, util.inspect, logger
 * payloads) yields the masked form, so the URL cannot reach a log line or a
 * response body by accident. Only client construction calls `reveal()`.
 */
export class SecretUrl {
  readonly transport: RpcTransport;
  readonly host: string;
  readonly masked: string;
  readonly fingerprint: string;
  readonly #raw: string;

  private constructor(raw: string, parsed: URL, transport: RpcTransport) {
    this.#raw = raw;
    this.transport = transport;
    this.host = parsed.host;
    const hasSecretPart =
      (parsed.pathname.length > 0 && parsed.pathname !== ROOT_PATH) ||
      parsed.search.length > 0 ||
      parsed.username.length > 0 ||
      parsed.password.length > 0;
    this.masked = `${parsed.protocol}//${parsed.host}${hasSecretPart ? `/${MASK}` : ""}`;
    this.fingerprint = createHash(FINGERPRINT_HASH)
      .update(parsed.toString())
      .digest(FINGERPRINT_ENCODING);
  }

  static parse(raw: string): SecretUrl {
    const trimmed = raw.trim();
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      throw new TypeError("Invalid RPC URL");
    }
    const transport = SCHEME_TRANSPORT[parsed.protocol];
    if (!transport) {
      throw new TypeError(
        `Unsupported RPC URL scheme ${parsed.protocol.replace(":", "")}`
      );
    }
    return new SecretUrl(trimmed, parsed, transport);
  }

  /** Parse an optional column value; empty and missing values become undefined. */
  static parseOptional(raw: string | null | undefined): SecretUrl | undefined {
    if (raw === null || raw === undefined || raw.trim().length === 0) {
      return;
    }
    return SecretUrl.parse(raw);
  }

  reveal(): string {
    return this.#raw;
  }

  toString(): string {
    return this.masked;
  }

  toJSON(): string {
    return this.masked;
  }

  [inspect.custom](): string {
    return `SecretUrl(${this.masked})`;
  }
}
