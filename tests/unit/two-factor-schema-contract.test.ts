// Better Auth's two-factor plugin writes to the twoFactor model by *field name*,
// and the drizzle adapter maps those names to our table's properties. A field the
// plugin writes but our table lacks is silently stripped, and when that leaves
// nothing to write the adapter emits `UPDATE two_factor SET  WHERE ...`, which
// Postgres rejects outright.
//
// That is not hypothetical. It happened twice: first with `verified`, then with
// the account-lockout fields (`failedVerificationCount`, `lockedUntil`), where a
// correct TOTP code 500'd after validating because resetTwoFactorFailures runs on
// every successful verification.
//
// So rather than listing the fields we happen to know about, this test reads them
// from the plugin itself. A Better Auth upgrade that adds a field to this model
// fails here instead of in production.

import { describe, expect, it, vi } from "vitest";

// lib/db/schema pulls in no Redis, but keep the stub in line with the other
// auth-adjacent unit tests so the module graph resolves without a live Redis.
vi.mock("ioredis", () => ({ Redis: class {} }));

import { twoFactor as twoFactorPlugin } from "better-auth/plugins";

import { twoFactor as twoFactorTable } from "@/lib/db/schema";

/** Field names Better Auth declares on the twoFactor model. */
function pluginFieldNames(): string[] {
  const plugin = twoFactorPlugin();
  const fields = (
    plugin.schema as
      | { twoFactor?: { fields?: Record<string, unknown> } }
      | undefined
  )?.twoFactor?.fields;
  return Object.keys(fields ?? {});
}

/** Property names on our drizzle table (what the adapter maps onto). */
function tablePropertyNames(): string[] {
  return Object.keys(twoFactorTable);
}

describe("two_factor schema contract with Better Auth", () => {
  it("declares every field the plugin writes", () => {
    const missing = pluginFieldNames().filter(
      (field) => !tablePropertyNames().includes(field)
    );

    expect(
      missing,
      `lib/db/schema.ts twoFactor is missing ${missing.join(", ")}. The adapter ` +
        "strips unknown fields, so an update touching only these emits an empty " +
        "SET and Postgres rejects it. Add the columns and a migration."
    ).toEqual([]);
  });

  it("still covers the account-lockout fields specifically", () => {
    // These two are what broke sign-in, and they are what makes
    // assertTwoFactorNotLocked able to enforce anything at all - it gates on
    // lockedUntil, which reads as undefined when the column is absent.
    const properties = tablePropertyNames();
    expect(properties).toContain("failedVerificationCount");
    expect(properties).toContain("lockedUntil");
  });

  it("uses the plugin's field names verbatim, since the adapter maps by property", () => {
    // A column named differently (failed_count, locked_at, ...) would compile and
    // migrate cleanly while still being invisible to the plugin.
    expect(pluginFieldNames()).toContain("failedVerificationCount");
    expect(pluginFieldNames()).toContain("lockedUntil");
  });
});
