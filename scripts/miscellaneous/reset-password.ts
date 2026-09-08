/**
 * Reset password for a user
 * Usage: DATABASE_URL="..." npx tsx scripts/reset-password.ts <email> <new-password>
 */

import { randomBytes, type ScryptOptions, scrypt } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../../lib/db";
import { accounts, users } from "../../lib/db/schema";

function scryptAsync(
  password: string,
  salt: string,
  keylen: number,
  options: ScryptOptions
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, options, (err, derivedKey) => {
      if (err) {
        reject(err);
      } else {
        resolve(derivedKey);
      }
    });
  });
}

// Better-auth compatible password hashing (matches their implementation exactly)
const config = {
  N: 16_384,
  r: 16,
  p: 1,
  dkLen: 64,
};

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function hashPassword(password: string): Promise<string> {
  const saltBytes = randomBytes(16);
  const salt = bytesToHex(saltBytes);
  const key = await scryptAsync(
    password.normalize("NFKC"),
    salt,
    config.dkLen,
    {
      N: config.N,
      p: config.p,
      r: config.r,
      maxmem: 128 * config.N * config.r * 2,
    }
  );
  return `${salt}:${bytesToHex(key)}`;
}

async function resetPassword(userEmail: string, password: string) {
  console.log(`Resetting password for: ${userEmail}`);

  // Find user
  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.email, userEmail))
    .limit(1);

  if (!user) {
    console.error(`User not found: ${userEmail}`);
    process.exit(1);
  }

  console.log(`Found user: ${user.id}`);

  // Find credential account
  const [account] = await db
    .select()
    .from(accounts)
    .where(eq(accounts.userId, user.id))
    .limit(1);

  if (!account) {
    console.error(`No credential account found for user: ${userEmail}`);
    process.exit(1);
  }

  // Hash new password using better-auth's exact algorithm
  const hashedPassword = await hashPassword(password);
  console.log(`Generated hash: ${hashedPassword.substring(0, 40)}...`);

  // Update password
  await db
    .update(accounts)
    .set({ password: hashedPassword, updatedAt: new Date() })
    .where(eq(accounts.id, account.id));

  console.log(`Password updated successfully for: ${userEmail}`);
  process.exit(0);
}

// Parse args
const [, , email, newPassword] = process.argv;

if (!(email && newPassword)) {
  console.error(
    "Usage: DATABASE_URL=... npx tsx scripts/reset-password.ts <email> <new-password>"
  );
  process.exit(1);
}

resetPassword(email, newPassword);
