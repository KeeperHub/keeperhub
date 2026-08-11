import { createHmac, timingSafeEqual } from "node:crypto";
import { symmetricDecrypt } from "better-auth/crypto";

const PERIOD_SECONDS = 30;
const DIGITS = 6;
const WINDOW = 1;
const DIGITS_ONLY_RE = /^\d+$/;

/**
 * RFC 6238 TOTP / RFC 4226 HOTP generator. Mirrors @better-auth/utils
 * otp.mjs:generateHOTP: the secret string is HMAC-SHA1'd with the
 * 8-byte big-endian counter as the message, dynamic-truncated, and
 * reduced mod 10^digits. Output is zero-padded to `digits` width.
 *
 * Inlined here because @better-auth/utils' createOTP is a transitive
 * dep we can't add as a direct import without expanding the pnpm
 * minimum-release-age allowlist further. The algorithm is stable and
 * exhaustively specified, so reimplementing it is safer than the
 * allowlist churn.
 */
function generateTotp(secret: string, counter: number): string {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac("sha1", Buffer.from(secret, "utf8"))
    .update(buffer)
    .digest();
  const offset = (hmac.at(-1) ?? 0) & 0xf;
  const truncated =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  const code = truncated % 10 ** DIGITS;
  return code.toString().padStart(DIGITS, "0");
}

/**
 * Validates a 6-digit TOTP code against an encrypted secret pulled
 * from the two_factor table. Used by flows that cannot call
 * auth.api.verifyTOTP because the caller isn't yet authenticated —
 * notably the password-reset path where the email-OTP step is the
 * only thing identifying the user.
 *
 * Allows ±WINDOW steps (one 30s step in either direction) for clock
 * skew, matching the better-auth plugin's default. Comparison is
 * timing-safe.
 *
 * Returns true if the code matches any window. Returns false on:
 *   - secret decryption failure (corrupted row, key mismatch)
 *   - malformed input (wrong length, non-numeric)
 *   - no window match
 */
export async function verifyUserTotp(
  encryptedSecret: string,
  providedCode: string,
  serverSecret: string
): Promise<boolean> {
  if (providedCode.length !== DIGITS || !DIGITS_ONLY_RE.test(providedCode)) {
    return false;
  }
  let decrypted: string;
  try {
    decrypted = await symmetricDecrypt({
      key: serverSecret,
      data: encryptedSecret,
    });
  } catch {
    return false;
  }
  const providedBuf = Buffer.from(providedCode, "utf8");
  const nowStep = Math.floor(Date.now() / 1000 / PERIOD_SECONDS);
  for (let i = -WINDOW; i <= WINDOW; i++) {
    const expected = generateTotp(decrypted, nowStep + i);
    const expectedBuf = Buffer.from(expected, "utf8");
    if (
      expectedBuf.length === providedBuf.length &&
      timingSafeEqual(expectedBuf, providedBuf)
    ) {
      return true;
    }
  }
  return false;
}
