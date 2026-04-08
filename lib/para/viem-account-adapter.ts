import "server-only";
import { Environment, Para as ParaServer } from "@getpara/server-sdk";
import type {
  Address,
  AuthorizationRequest,
  Hex,
  LocalAccount,
  SignableMessage,
  SignedAuthorization,
} from "viem";
import {
  hashAuthorization,
  hashMessage,
  hashTypedData,
  serializeTransaction,
} from "viem/utils";
import { decryptUserShare } from "@/lib/encryption";
import { getOrganizationWallet } from "@/lib/para/wallet-helpers";

type ParaWalletRecord = {
  userId: string;
  paraWalletId: string | null;
  walletAddress: string;
  userShare: string | null;
};

function hexToBase64(hex: string): string {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  return Buffer.from(clean, "hex").toString("base64");
}

function parseSignature(sigHex: string): { r: Hex; s: Hex; v: bigint } {
  const clean = sigHex.startsWith("0x") ? sigHex.slice(2) : sigHex;
  const r = `0x${clean.slice(0, 64)}` as Hex;
  const s = `0x${clean.slice(64, 128)}` as Hex;
  const vByte = Number.parseInt(clean.slice(128, 130), 16);
  const v = BigInt(vByte < 27 ? vByte + 27 : vByte);
  return { r, s, v };
}

function initializeParaClient(): ParaServer {
  const apiKey = process.env.PARA_API_KEY;
  if (!apiKey) {
    throw new Error("PARA_API_KEY not configured");
  }
  const env = process.env.PARA_ENVIRONMENT || "beta";
  const disableWebSockets = process.env.PARA_DISABLE_WEBSOCKETS === "true";
  return new ParaServer(
    env === "prod" ? Environment.PROD : Environment.BETA,
    apiKey,
    { disableWebSockets }
  );
}

/**
 * Creates a viem LocalAccount backed by Para's MPC signing.
 *
 * The returned account delegates signMessage/signTypedData/signTransaction
 * to Para's server-side MPC protocol via user shares. This allows it to
 * be used as the `owner` for permissionless.js smart account clients.
 *
 * Para's signMessage signs raw bytes directly -- the EIP-191/712 prefixes
 * are added by viem's hashMessage/hashTypedData at the adapter layer.
 * This means account.sign({ hash }) works for EIP-7702 authorization
 * signing via hashAuthorization() + sign().
 */
export async function createParaViemAccount(
  organizationId: string
): Promise<{ account: LocalAccount; walletRecord: ParaWalletRecord }> {
  const walletRecord = await getOrganizationWallet(organizationId);
  const paraClient = initializeParaClient();

  if (!(walletRecord.userShare && walletRecord.paraWalletId)) {
    throw new Error(
      "Wallet missing Para credentials (userShare or paraWalletId)"
    );
  }

  const decryptedShare = decryptUserShare(walletRecord.userShare);
  await paraClient.setUserShare(decryptedShare);

  const walletId = walletRecord.paraWalletId;
  const address = walletRecord.walletAddress as Address;

  async function signRawHash(hash: Hex): Promise<Hex> {
    const res = await paraClient.signMessage({
      walletId,
      messageBase64: hexToBase64(hash),
    });
    if (!("signature" in res)) {
      throw new Error("Para signing was denied");
    }
    // Para returns v as yParity (0/1) but on-chain ECDSA expects v=27/28
    const sig = res.signature;
    const vByte = Number.parseInt(sig.slice(-2), 16);
    if (vByte < 27) {
      const normalizedV = (vByte + 27).toString(16).padStart(2, "0");
      return `0x${sig.slice(0, -2)}${normalizedV}` as Hex;
    }
    return `0x${sig}` as Hex;
  }

  const account: LocalAccount = {
    address,
    // publicKey is not recoverable from address alone; permissionless.js
    // only uses the address field from the owner account
    publicKey: "0x" as Hex,
    source: "para" as string,
    type: "local",

    async sign({ hash }: { hash: Hex }): Promise<Hex> {
      return await signRawHash(hash);
    },

    async signMessage({ message }: { message: SignableMessage }): Promise<Hex> {
      const hash = hashMessage(message);
      return await signRawHash(hash);
    },

    async signTransaction(transaction, _options?): Promise<Hex> {
      const serialized = serializeTransaction(transaction);
      const res = await paraClient.signMessage({
        walletId,
        messageBase64: hexToBase64(serialized),
      });
      if (!("signature" in res)) {
        throw new Error("Para transaction signing was denied");
      }
      const { r, s, v } = parseSignature(res.signature);
      const yParity = v === BigInt(28) ? 1 : 0;
      return serializeTransaction(transaction, {
        r,
        s,
        yParity,
      });
    },

    // biome-ignore lint/suspicious/noExplicitAny: viem TypedDataDefinition generic is complex
    async signTypedData(parameters: any): Promise<Hex> {
      const hash = hashTypedData(parameters);
      return await signRawHash(hash);
    },

    async signAuthorization(
      authorization: AuthorizationRequest
    ): Promise<SignedAuthorization> {
      const hash = hashAuthorization(authorization);
      const sigHex = await signRawHash(hash);
      const { r, s, v } = parseSignature(sigHex);
      const yParity = v === BigInt(28) ? 1 : 0;
      const contractAddress =
        "address" in authorization
          ? authorization.address
          : authorization.contractAddress;
      return {
        address: contractAddress,
        chainId: authorization.chainId ?? 0,
        nonce: authorization.nonce ?? 0,
        r,
        s,
        yParity,
      } as SignedAuthorization;
    },
  };

  return { account, walletRecord };
}
