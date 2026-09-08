/**
 * Password hashing utilities for KeeperHub
 * Uses Better Auth's scrypt configuration for compatibility
 */

import { randomBytes, type ScryptOptions, scrypt } from "node:crypto";

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

// Better Auth compatible password hashing config
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

/**
 * Hash a password using Better Auth's scrypt configuration
 * @param password - The plaintext password to hash
 * @returns The hashed password in format "{salt}:{hash}"
 */
export async function hashPassword(password: string): Promise<string> {
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

/**
 * Verify a password against a stored hash
 * @param password - The plaintext password to verify
 * @param storedHash - The stored hash in format "{salt}:{hash}"
 * @returns True if password matches, false otherwise
 */
export async function verifyPassword(
  password: string,
  storedHash: string
): Promise<boolean> {
  const [salt, hash] = storedHash.split(":");
  if (!(salt && hash)) {
    return false;
  }

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

  const computedHash = bytesToHex(key);

  // Constant-time comparison to prevent timing attacks
  if (computedHash.length !== hash.length) {
    return false;
  }

  let result = 0;
  for (let i = 0; i < computedHash.length; i++) {
    result |= computedHash.charCodeAt(i) ^ hash.charCodeAt(i);
  }
  return result === 0;
}
