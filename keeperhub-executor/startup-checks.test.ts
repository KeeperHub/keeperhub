import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertTurnkeyEnvForActiveWallets } from "./startup-checks";

const PUBLIC_KEY_PATTERN = /TURNKEY_API_PUBLIC_KEY/;
const PRIVATE_KEY_PATTERN = /TURNKEY_API_PRIVATE_KEY/;
const BOTH_KEYS_PATTERN = /TURNKEY_API_PUBLIC_KEY.*TURNKEY_API_PRIVATE_KEY/;
const ORGANIZATION_ID_PATTERN = /TURNKEY_ORGANIZATION_ID/;
const CONNECTION_REFUSED_PATTERN = /connection refused/;

type AssertDb = Parameters<typeof assertTurnkeyEnvForActiveWallets>[0];

type Chain = {
  from: () => Chain;
  where: () => Chain;
  limit: () => Promise<Array<{ id: string }>>;
};

function makeDb(rows: Array<{ id: string }>): AssertDb {
  const chain: Chain = {
    from: () => chain,
    where: () => chain,
    limit: () => Promise.resolve(rows),
  };
  return {
    select: (): Chain => chain,
  } as unknown as AssertDb;
}

function makeFailingDb(error: Error): AssertDb {
  const chain: Chain = {
    from: () => chain,
    where: () => chain,
    limit: () => Promise.reject(error),
  };
  return {
    select: (): Chain => chain,
  } as unknown as AssertDb;
}

describe("assertTurnkeyEnvForActiveWallets", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    const {
      TURNKEY_API_PUBLIC_KEY: _pub,
      TURNKEY_API_PRIVATE_KEY: _priv,
      TURNKEY_ORGANIZATION_ID: _org,
      K8S_NAMESPACE: _ns,
      ...rest
    } = originalEnv;
    process.env = rest;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("resolves when no active Turnkey wallets exist, even with no env", async () => {
    const db = makeDb([]);

    await expect(assertTurnkeyEnvForActiveWallets(db)).resolves.toBeUndefined();
  });

  it("resolves when active Turnkey wallets exist and all env vars are set", async () => {
    process.env.TURNKEY_API_PUBLIC_KEY = "pub-test";
    process.env.TURNKEY_API_PRIVATE_KEY = "priv-test";
    process.env.TURNKEY_ORGANIZATION_ID = "org-test";
    const db = makeDb([{ id: "wallet-1" }]);

    await expect(assertTurnkeyEnvForActiveWallets(db)).resolves.toBeUndefined();
  });

  it("throws naming the missing public key when only private is set", async () => {
    process.env.TURNKEY_API_PRIVATE_KEY = "priv-test";
    process.env.TURNKEY_ORGANIZATION_ID = "org-test";
    const db = makeDb([{ id: "wallet-1" }]);

    await expect(assertTurnkeyEnvForActiveWallets(db)).rejects.toThrow(
      PUBLIC_KEY_PATTERN
    );
  });

  it("throws naming the missing private key when only public is set", async () => {
    process.env.TURNKEY_API_PUBLIC_KEY = "pub-test";
    process.env.TURNKEY_ORGANIZATION_ID = "org-test";
    const db = makeDb([{ id: "wallet-1" }]);

    await expect(assertTurnkeyEnvForActiveWallets(db)).rejects.toThrow(
      PRIVATE_KEY_PATTERN
    );
  });

  it("throws naming the missing organization id when only keys are set", async () => {
    process.env.TURNKEY_API_PUBLIC_KEY = "pub-test";
    process.env.TURNKEY_API_PRIVATE_KEY = "priv-test";
    const db = makeDb([{ id: "wallet-1" }]);

    await expect(assertTurnkeyEnvForActiveWallets(db)).rejects.toThrow(
      ORGANIZATION_ID_PATTERN
    );
  });

  it("throws naming both missing keys together", async () => {
    process.env.TURNKEY_ORGANIZATION_ID = "org-test";
    const db = makeDb([{ id: "wallet-1" }]);

    await expect(assertTurnkeyEnvForActiveWallets(db)).rejects.toThrow(
      BOTH_KEYS_PATTERN
    );
  });

  it("treats empty-string env as missing", async () => {
    process.env.TURNKEY_API_PUBLIC_KEY = "";
    process.env.TURNKEY_API_PRIVATE_KEY = "";
    process.env.TURNKEY_ORGANIZATION_ID = "org-test";
    const db = makeDb([{ id: "wallet-1" }]);

    await expect(assertTurnkeyEnvForActiveWallets(db)).rejects.toThrow(
      BOTH_KEYS_PATTERN
    );
  });

  it("does not throw on missing env in an ephemeral PR environment", async () => {
    process.env.K8S_NAMESPACE = "pr-1373";
    const db = makeDb([{ id: "wallet-1" }]);

    await expect(assertTurnkeyEnvForActiveWallets(db)).resolves.toBeUndefined();
  });

  it("rethrows a query failure outside ephemeral environments", async () => {
    const db = makeFailingDb(new Error("connection refused"));

    await expect(assertTurnkeyEnvForActiveWallets(db)).rejects.toThrow(
      CONNECTION_REFUSED_PATTERN
    );
  });

  it("does not throw on a query failure in an ephemeral PR environment", async () => {
    process.env.K8S_NAMESPACE = "pr-1373";
    const db = makeFailingDb(new Error("connection refused"));

    await expect(assertTurnkeyEnvForActiveWallets(db)).resolves.toBeUndefined();
  });
});
