import { decrypt, encrypt } from "@/lib/db/encryption";
import type { OrganizationRpcConfigRow } from "@/lib/db/schema-rpc";
import { SecretUrl } from "../secret-url";
import type { OrgRpcConfig } from "../types";
import {
  RPC_CONFIG_URL_SLOTS,
  type RpcConfigUrlSlot,
  type RpcConfigUrls,
} from "./url-slots";

/**
 * Encrypt a config's URLs for storage. Each URL is parsed first so a
 * malformed one is refused before anything is written. Nothing derived from
 * a URL leaves this function except the ciphertext.
 */
export function encodeRpcConfigUrls(urls: RpcConfigUrls): string {
  const stored: Partial<RpcConfigUrls> = {};
  for (const slot of RPC_CONFIG_URL_SLOTS) {
    const raw = urls[slot];
    if (raw) {
      stored[slot] = SecretUrl.parse(raw).reveal();
    }
  }
  return encrypt(JSON.stringify(stored));
}

/** Which URL slots a stored config fills. Safe to show to any member. */
export function filledUrlSlots(
  urls: Partial<RpcConfigUrls>
): RpcConfigUrlSlot[] {
  return RPC_CONFIG_URL_SLOTS.filter((slot) => Boolean(urls[slot]));
}

export function decodeRpcConfigUrls(encryptedUrls: string): RpcConfigUrls {
  return JSON.parse(decrypt(encryptedUrls)) as RpcConfigUrls;
}

/** The fields of a config besides its URLs. */
export type OrgRpcConfigFields = Pick<
  OrgRpcConfig,
  "id" | "name" | "chainId" | "enabled" | "isDefault"
>;

/** A config in the shape the resolver works with, from its plain URLs. */
export function orgRpcConfigFromUrls(
  fields: OrgRpcConfigFields,
  urls: RpcConfigUrls
): OrgRpcConfig {
  return {
    id: fields.id,
    name: fields.name,
    chainId: fields.chainId,
    enabled: fields.enabled,
    isDefault: fields.isDefault,
    httpPrimary: SecretUrl.parse(urls.httpPrimary),
    httpFallback: SecretUrl.parseOptional(urls.httpFallback),
    wssPrimary: SecretUrl.parseOptional(urls.wssPrimary),
    wssFallback: SecretUrl.parseOptional(urls.wssFallback),
    privateTx: SecretUrl.parseOptional(urls.privateTx),
  };
}

/** Turn a stored row into the shape the resolver works with. */
export function orgRpcConfigFromRow(
  row: OrganizationRpcConfigRow
): OrgRpcConfig {
  return orgRpcConfigFromUrls(row, decodeRpcConfigUrls(row.encryptedUrls));
}
