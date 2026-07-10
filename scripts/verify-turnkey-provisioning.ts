/**
 * Manual integration smoke-test: verify that createTurnkeyWallet provisions
 * both an EVM and a Solana address against the real Turnkey API.
 *
 * NOTE: This script creates a REAL sub-organization in your Turnkey account.
 * Use a sandbox / test organization ID, not production.
 *
 * Usage (PowerShell):
 *   Get-Content .env.local | ForEach-Object {
 *     if ($_ -match '^(\w+)=(.+)$') {
 *       [System.Environment]::SetEnvironmentVariable($Matches[1], $Matches[2])
 *     }
 *   }
 *   npx tsx scripts/verify-turnkey-provisioning.ts
 */

import { createTurnkeyWallet } from "../lib/turnkey/turnkey-operations";

const required = [
  "TURNKEY_API_PUBLIC_KEY",
  "TURNKEY_API_PRIVATE_KEY",
  "TURNKEY_ORGANIZATION_ID",
] as const;

for (const key of required) {
  if (!process.env[key]) {
    console.error(`Missing required env var: ${key}`);
    process.exit(1);
  }
}

// Unique test org name so repeated runs don't collide
const testOrgName = `smoke-${Date.now()}`;
const testEmail = `smoke+${Date.now()}@keeperhub-test.invalid`;

console.log(`\nTurnkey provisioning smoke test`);
console.log(`  Organization ID : ${process.env.TURNKEY_ORGANIZATION_ID}`);
console.log(`  Test sub-org    : keeperhub-${testOrgName}`);
console.log(`  Test email      : ${testEmail}`);
console.log("");

async function main(): Promise<void> {
  let exitCode = 0;

  try {
    console.log("Calling createTurnkeyWallet (primary: EVM + Solana)...");
    const result = await createTurnkeyWallet(testEmail, testOrgName);

    console.log("\nResult:");
    console.log(`  subOrgId      : ${result.subOrgId}`);
    console.log(`  walletId      : ${result.walletId}`);
    console.log(`  walletAddress : ${result.walletAddress}   (EVM)`);
    console.log(`  solanaAddress : ${result.solanaAddress ?? "(null)"}`);
    console.log(
      `  privateKeyId  : "${result.privateKeyId}" (expected empty string)`
    );
    console.log("");

    const checks: Array<{ label: string; ok: boolean; detail?: string }> = [
      {
        label: "subOrgId is non-empty",
        ok: Boolean(result.subOrgId),
      },
      {
        label: "walletId is non-empty",
        ok: Boolean(result.walletId),
      },
      {
        label: "walletAddress is a valid EVM address (0x + 40 hex chars)",
        ok: /^0x[0-9a-fA-F]{40}$/.test(result.walletAddress),
        detail: result.walletAddress,
      },
      {
        label: "solanaAddress is a non-null base58 string",
        ok:
          typeof result.solanaAddress === "string" &&
          result.solanaAddress.length >= 32,
        detail: result.solanaAddress ?? "(null)",
      },
      {
        label: "privateKeyId is empty string (intentional, not a bug)",
        ok: result.privateKeyId === "",
        detail: `got: "${result.privateKeyId}"`,
      },
    ];

    for (const check of checks) {
      const icon = check.ok ? "PASS" : "FAIL";
      const detail = check.detail ? `  [${check.detail}]` : "";
      console.log(`  [${icon}] ${check.label}${detail}`);
      if (!check.ok) exitCode = 1;
    }
  } catch (err) {
    console.error("\ncreateTurnkeyWallet threw an error:");
    console.error(err);
    exitCode = 1;
  }

  console.log("");
  if (exitCode === 0) {
    console.log(
      "All checks passed. EVM + Solana provisioning working correctly."
    );
  } else {
    console.log("One or more checks FAILED. See output above.");
  }

  process.exit(exitCode);
}

main();
