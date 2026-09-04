import { createHash } from "node:crypto";
import { railForProtocol } from "@/lib/payments/rails";

const MPP_RAIL = railForProtocol("mpp");
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
    methods: [tempo.charge({ currency: MPP_RAIL.asset })],
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
