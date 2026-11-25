import { decrypt, encrypt } from "@/lib/db/encryption";
import type { OrganizationRpcConfigRow } from "@/lib/db/schema-rpc";
import { SecretUrl } from "../secret-url";
import type { OrgRpcConfig } from "../types";
import {
  RPC_CONFIG_URL_SLOTS,
  type RpcConfigMaskedUrls,
  type RpcConfigUrls,
} from "./url-slots";

export type EncodedRpcConfigUrls = {
  encryptedUrls: string;
  maskedUrls: RpcConfigMaskedUrls;
};

/** Encrypt a config's URLs for storage and derive what members may see. */
export function encodeRpcConfigUrls(urls: RpcConfigUrls): EncodedRpcConfigUrls {
  const stored: Partial<RpcConfigUrls> = {};
  const maskedUrls: RpcConfigMaskedUrls = {};
  for (const slot of RPC_CONFIG_URL_SLOTS) {
    const raw = urls[slot];
    if (raw) {
      const url = SecretUrl.parse(raw);
      stored[slot] = url.reveal();
      maskedUrls[slot] = url.masked;
    }
  }
  return { encryptedUrls: encrypt(JSON.stringify(stored)), maskedUrls };
}

export function decodeRpcConfigUrls(encryptedUrls: string): RpcConfigUrls {
  return JSON.parse(decrypt(encryptedUrls)) as RpcConfigUrls;
}

/** Turn a stored row into the shape the resolver works with. */
export function orgRpcConfigFromRow(
  row: OrganizationRpcConfigRow
): OrgRpcConfig {
  const urls = decodeRpcConfigUrls(row.encryptedUrls);
  return {
    id: row.id,
    name: row.name,
    chainId: row.chainId,
    enabled: row.enabled,
    isDefault: row.isDefault,
    httpPrimary: SecretUrl.parse(urls.httpPrimary),
    httpFallback: SecretUrl.parseOptional(urls.httpFallback),
    wssPrimary: SecretUrl.parseOptional(urls.wssPrimary),
    wssFallback: SecretUrl.parseOptional(urls.wssFallback),
    privateTx: SecretUrl.parseOptional(urls.privateTx),
  };
}
