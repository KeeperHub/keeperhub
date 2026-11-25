import { RpcTransport } from "../types";
import type { RpcUrlCheckFailure } from "./verify";

/** The URLs one organization RPC config can hold. */
export const RpcConfigUrlSlot = {
  HTTP_PRIMARY: "httpPrimary",
  HTTP_FALLBACK: "httpFallback",
  WSS_PRIMARY: "wssPrimary",
  WSS_FALLBACK: "wssFallback",
  PRIVATE_TX: "privateTx",
} as const;
export type RpcConfigUrlSlot =
  (typeof RpcConfigUrlSlot)[keyof typeof RpcConfigUrlSlot];

export const RPC_CONFIG_URL_SLOTS: readonly RpcConfigUrlSlot[] =
  Object.values(RpcConfigUrlSlot);

/** The transport each slot must use. */
export const SLOT_TRANSPORT: Readonly<Record<RpcConfigUrlSlot, RpcTransport>> =
  {
    [RpcConfigUrlSlot.HTTP_PRIMARY]: RpcTransport.HTTP,
    [RpcConfigUrlSlot.HTTP_FALLBACK]: RpcTransport.HTTP,
    [RpcConfigUrlSlot.WSS_PRIMARY]: RpcTransport.WSS,
    [RpcConfigUrlSlot.WSS_FALLBACK]: RpcTransport.WSS,
    [RpcConfigUrlSlot.PRIVATE_TX]: RpcTransport.HTTP,
  };

/** Raw URLs by slot. Only ever held server side, and stored encrypted. */
export type RpcConfigUrls = Partial<Record<RpcConfigUrlSlot, string>> & {
  [RpcConfigUrlSlot.HTTP_PRIMARY]: string;
};

/** Masked URLs by slot, safe to return to any member. */
export type RpcConfigMaskedUrls = Partial<Record<RpcConfigUrlSlot, string>>;

export type RpcUrlCheck = {
  ok: boolean;
  checkedAt: string;
  code?: RpcUrlCheckFailure;
  /** A user-facing reason, never containing the URL. */
  error?: string;
};

export type RpcConfigVerification = Partial<
  Record<RpcConfigUrlSlot, RpcUrlCheck>
>;
