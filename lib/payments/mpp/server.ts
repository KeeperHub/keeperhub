import { createHash } from "node:crypto";

const TEMPO_USDC_ADDRESS = "0x20c000000000000000000000b9537d11c60e8b50";
const RE_PROTOCOL = /^https?:\/\//;
const RE_TRAILING_SLASH = /\/$/;

function resolveRealm(): string {
  return (process.env.NEXT_PUBLIC_APP_URL ?? "app.keeperhub.com")
    .replace(RE_PROTOCOL, "")
    .replace(RE_TRAILING_SLASH, "");
}

async function createMppServer(): Promise<unknown> {
  const { Mppx, tempo } = await import("mppx/server");
  return Mppx.create({
    secretKey: process.env.MPP_SECRET_KEY,
    realm: resolveRealm(),
    methods: [tempo.charge({ currency: TEMPO_USDC_ADDRESS })],
  });
}

let _mppServer: unknown = null;

export async function getMppServer(): Promise<unknown> {
  if (!_mppServer) {
    _mppServer = await createMppServer();
  }
  return _mppServer;
}

export function extractMppPayerAddress(source: string | null): string | null {
  if (!source) {
    return null;
  }
  if (!source.includes(":")) {
    return source.startsWith("0x") ? source : null;
  }
  const parts = source.split(":");
  return parts.at(-1) ?? null;
}

export function hashMppCredential(authHeaderValue: string): string {
  return createHash("sha256").update(authHeaderValue).digest("hex");
}
