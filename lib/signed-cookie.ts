import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Generic HMAC-signed cookie codec shared by the four signed-cookie modules
 * (lib/device-cookie.ts, lib/pending-ip-cookie.ts, lib/pending-signup-cookie.ts,
 * lib/oauth-mfa-cookie.ts). Holds the single copy of the base64url
 * encode/decode helpers, the HMAC-SHA256 signing step, the
 * dot-split + constant-time MAC compare decode skeleton, and the
 * Set-Cookie / clear-cookie builders. Each module instantiates a codec with
 * its own cookie name, TTL, and payload validation and keeps its exact
 * public function names and signatures.
 *
 * Security invariants (do not weaken):
 *   - MAC compare is length-checked then timingSafeEqual on every decode.
 *   - When `embedExpiry` is set, the payload's own expiresAt is re-checked
 *     against Date.now() on every decode; the Max-Age attribute alone is
 *     never trusted.
 */

const PLUS_RE = /\+/g;
const SLASH_RE = /\//g;
const TRAILING_EQ_RE = /=+$/;
const DASH_RE = /-/g;
const UNDERSCORE_RE = /_/g;

function base64UrlEncode(input: Buffer | string): string {
  const buf = typeof input === "string" ? Buffer.from(input) : input;
  return buf
    .toString("base64")
    .replace(PLUS_RE, "-")
    .replace(SLASH_RE, "_")
    .replace(TRAILING_EQ_RE, "");
}

function base64UrlDecode(input: string): Buffer {
  const padded = input.replace(DASH_RE, "+").replace(UNDERSCORE_RE, "/");
  const pad = padded.length % 4 === 0 ? 0 : 4 - (padded.length % 4);
  return Buffer.from(padded + "=".repeat(pad), "base64");
}

function sign(payload: string, secret: string): string {
  return base64UrlEncode(createHmac("sha256", secret).update(payload).digest());
}

export type SignedCookieDecodeResult<TPayload> =
  | { ok: true; payload: TPayload }
  | { ok: false; reason: "malformed" | "bad_signature" | "expired" };

export type SignedCookieCodec<TPayload> = {
  cookieName: () => string;
  /** Signs the payload exactly as given; callers embed expiresAt themselves. */
  encode: (payload: TPayload, secret: string) => string;
  decode: (
    cookieValue: string,
    secret: string
  ) => SignedCookieDecodeResult<TPayload>;
  buildSetCookie: (encodedValue: string, ttlMs?: number) => string;
  buildClearCookie: () => string;
  read: (headers: Headers) => string | null;
};

export function createSignedCookieCodec<TPayload>(options: {
  cookieName: string;
  defaultTtlMs: number;
  validatePayload: (payload: TPayload) => boolean;
  /** When true, decode re-checks the payload's embedded expiresAt. */
  embedExpiry: boolean;
}): SignedCookieCodec<TPayload> {
  const { cookieName, defaultTtlMs, validatePayload, embedExpiry } = options;

  return {
    cookieName(): string {
      return cookieName;
    },
    encode(payload: TPayload, secret: string): string {
      const encoded = base64UrlEncode(JSON.stringify(payload));
      const mac = sign(encoded, secret);
      return `${encoded}.${mac}`;
    },
    decode(
      cookieValue: string,
      secret: string
    ): SignedCookieDecodeResult<TPayload> {
      const dot = cookieValue.indexOf(".");
      if (dot <= 0 || dot === cookieValue.length - 1) {
        return { ok: false, reason: "malformed" };
      }
      const encoded = cookieValue.slice(0, dot);
      const macClaim = cookieValue.slice(dot + 1);
      const macActual = sign(encoded, secret);
      const macClaimBuf = Buffer.from(macClaim);
      const macActualBuf = Buffer.from(macActual);
      if (macClaimBuf.length !== macActualBuf.length) {
        return { ok: false, reason: "bad_signature" };
      }
      if (!timingSafeEqual(macClaimBuf, macActualBuf)) {
        return { ok: false, reason: "bad_signature" };
      }
      let payload: TPayload;
      try {
        payload = JSON.parse(base64UrlDecode(encoded).toString()) as TPayload;
      } catch {
        return { ok: false, reason: "malformed" };
      }
      if (!validatePayload(payload)) {
        return { ok: false, reason: "malformed" };
      }
      if (embedExpiry) {
        const { expiresAt } = payload as { expiresAt?: unknown };
        if (typeof expiresAt !== "number") {
          return { ok: false, reason: "malformed" };
        }
        if (expiresAt <= Date.now()) {
          return { ok: false, reason: "expired" };
        }
      }
      return { ok: true, payload };
    },
    buildSetCookie(encodedValue: string, ttlMs: number = defaultTtlMs): string {
      const maxAge = Math.floor(ttlMs / 1000);
      const secureSegment =
        process.env.NODE_ENV === "production" ? " Secure;" : "";
      return `${cookieName}=${encodedValue}; Path=/; HttpOnly;${secureSegment} SameSite=Lax; Max-Age=${maxAge}`;
    },
    buildClearCookie(): string {
      const secureSegment =
        process.env.NODE_ENV === "production" ? " Secure;" : "";
      return `${cookieName}=; Path=/; HttpOnly;${secureSegment} SameSite=Lax; Max-Age=0`;
    },
    read(headers: Headers): string | null {
      const cookie = headers.get("cookie");
      if (!cookie) {
        return null;
      }
      for (const part of cookie.split(";")) {
        const trimmed = part.trim();
        if (trimmed.startsWith(`${cookieName}=`)) {
          return trimmed.slice(cookieName.length + 1);
        }
      }
      return null;
    },
  };
}
