import { z } from "zod";

/** EVM address: 0x followed by exactly 40 hex characters. */
export const EVM_ADDRESS_REGEX = /^0x[a-fA-F0-9]{40}$/;

const evmAddress = z
  .string()
  .regex(EVM_ADDRESS_REGEX, "Must be a valid EVM address");

// chainId may arrive as a number or a numeric string (the modal sends a
// number; some callers send a string). Either must denote a positive integer.
const chainId = z.union([
  z.number().int().positive(),
  z.string().regex(/^\d+$/, "chainId must be a positive integer"),
]);

/**
 * Body schema for POST /api/user/wallet/withdraw. `.strict()` rejects unknown
 * fields so a malformed or mass-assignment payload never reaches the
 * fund-moving path. The cross-field rules mirror the route's invariants:
 * fromMax is native-only, and an explicit amount is required unless fromMax
 * lets the server compute the drain value.
 */
export const withdrawSchema = z
  .object({
    chainId,
    recipient: evmAddress,
    tokenAddress: evmAddress.optional(),
    amount: z.string().optional(),
    fromMax: z.boolean().optional(),
    safeId: z.string().min(1).optional(),
    code: z.string().optional(),
    emailOtp: z.string().optional(),
    signature: z.string().optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (data.fromMax && data.tokenAddress) {
      ctx.addIssue({
        code: "custom",
        path: ["fromMax"],
        message: "fromMax is only valid for native transfers",
      });
    }

    if (data.fromMax) {
      return;
    }

    if (data.amount === undefined || data.amount.trim() === "") {
      ctx.addIssue({
        code: "custom",
        path: ["amount"],
        message: "amount is required unless fromMax is set",
      });
      return;
    }

    const parsed = Number.parseFloat(data.amount);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      ctx.addIssue({
        code: "custom",
        path: ["amount"],
        message: "amount must be a positive number",
      });
    }
  });

export type WithdrawInput = z.infer<typeof withdrawSchema>;

/**
 * Body schema for POST /api/user/wallet/export-key/verify. Both factors are
 * optional: the first call (empty body) mints and emails the OTP; the second
 * call submits the TOTP code plus the emailed OTP.
 */
export const exportKeyVerifySchema = z
  .object({
    code: z.string().optional(),
    emailOtp: z.string().optional(),
    signature: z.string().optional(),
    keyType: z.enum(["evm", "solana"]).optional(),
  })
  .strict();

export type ExportKeyVerifyInput = z.infer<typeof exportKeyVerifySchema>;
