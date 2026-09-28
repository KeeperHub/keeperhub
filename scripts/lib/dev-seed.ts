/**
 * Shared fixture values for the dev seed scripts.
 *
 * SEED_EMAIL's default had drifted into two values. The scripts that create
 * the user (seed-user.ts, seed-dev-user.ts) used dev@techops.services, while
 * eight scripts that look the user up used dev@keeperhub.local and then
 * printed "run seed-user.ts first" when they could not find it, advice that
 * could never work. dev@techops.services is the surviving value: it is what
 * the creating scripts write, and it is one of the two domains the
 * (since-dropped) block_user_signup_security trigger allowlisted, which
 * dev@keeperhub.local never was.
 */

export const SEED_EMAIL = process.env.SEED_EMAIL ?? "dev@techops.services";

/**
 * Better Auth's scrypt password parameters. Must match the values in
 * tests/e2e/playwright/utils/seed.ts so a seeded credential is verifiable
 * through the sign-in endpoint.
 */
export const SCRYPT_CONFIG = { N: 16_384, r: 16, p: 1, dkLen: 64 } as const;
