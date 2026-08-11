/**
 * Client-safe view type for a held Tempo payment. Shared by the broker's
 * `toHeldPaymentView` mapper (server), the API client, and the UI, so the shape
 * cannot drift. No server imports here -- safe to import from client components.
 */
export type HeldPaymentStatus =
  | "pending"
  | "broadcasting"
  | "broadcast"
  | "confirmed"
  | "failed"
  | "expired"
  | "canceled";

export const HELD_PAYMENT_STATUSES: HeldPaymentStatus[] = [
  "pending",
  "broadcasting",
  "broadcast",
  "confirmed",
  "failed",
  "expired",
  "canceled",
];

export type HeldPaymentView = {
  id: string;
  status: HeldPaymentStatus;
  chainId: number;
  from: string;
  to: string;
  tokenAddress: string;
  tokenSymbol: string | null;
  amount: string | null;
  amountRaw: string;
  memo: string | null;
  precomputedHash: string;
  broadcastMode: "manual" | "schedule";
  broadcastAt: string | null;
  validAfter: number | null;
  validBefore: number;
  broadcastTxHash: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
};
