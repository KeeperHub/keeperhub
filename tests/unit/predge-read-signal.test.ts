import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("@/lib/workflow/executor/step-handler", async () =>
  (await import("../mocks/step-mocks")).stepHandlerPassthrough()
);

vi.mock("@/lib/metrics/instrumentation/plugin", async () =>
  (await import("../mocks/step-mocks")).pluginMetricsPassthrough()
);

const mockFetchCredentials = vi.fn();
vi.mock("@/lib/credential-fetcher", () => ({
  fetchCredentials: (...args: unknown[]) => mockFetchCredentials(...args),
}));

// Predge egress routes through safeFetch (the SSRF guard), not the raw fetch
// global. Mock it so the step tests assert on a controlled response body.
const { safeFetch } = vi.hoisted(() => ({ safeFetch: vi.fn() }));
vi.mock("@/lib/safe-fetch", () => ({
  safeFetch,
  assertUrlIsPublic: vi.fn(() => Promise.resolve()),
  SsrfBlockedError: class SsrfBlockedError extends Error {},
}));

import {
  canonicalize,
  verifyPredgeSignal,
  type PredgeSignedAttestation,
} from "@/plugins/predge/steps/predge-core";
import { readSignalStep } from "@/plugins/predge/steps/read-signal";

const SCHEME = "veri402-ed25519-v1";
const WALLET = "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984";
const NOW = Date.parse("2026-09-16T12:00:00.000Z");

function toHex(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return Array.from(view)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

type Signer = { privateKey: CryptoKey; keyIdHex: string };

async function generateSigner(): Promise<Signer> {
  const pair = (await crypto.subtle.generateKey(
    { name: "Ed25519" },
    true,
    ["sign", "verify"]
  )) as CryptoKeyPair;
  const raw = await crypto.subtle.exportKey("raw", pair.publicKey);
  return { privateKey: pair.privateKey, keyIdHex: toHex(raw) };
}

type SignalOverrides = {
  wallet?: string;
  conviction?: number;
  action?: "accumulate" | "reduce" | "hold";
  window?: "7d" | "30d";
  issuedAt?: string;
  keyId?: string; // force a keyId different from the signer, for tamper cases
};

async function signSignal(
  signer: Signer,
  overrides: SignalOverrides = {}
): Promise<PredgeSignedAttestation> {
  const attestation = {
    scheme: SCHEME,
    resource: `conviction:${overrides.wallet ?? WALLET}`,
    payload: {
      wallet: overrides.wallet ?? WALLET,
      conviction: overrides.conviction ?? 82,
      action: overrides.action ?? ("accumulate" as const),
      window: overrides.window ?? ("30d" as const),
    },
    issuedAt: overrides.issuedAt ?? new Date(NOW).toISOString(),
    nonce: "0011223344556677",
    keyId: overrides.keyId ?? signer.keyIdHex,
  };
  const message = new TextEncoder().encode(canonicalize(attestation));
  const signature = await crypto.subtle.sign(
    { name: "Ed25519" },
    signer.privateKey,
    message
  );
  return { attestation, signature: toHex(signature) };
}

let signer: Signer;

beforeAll(async () => {
  signer = await generateSigner();
});

describe("verifyPredgeSignal", () => {
  it("accepts a signal signed by the pinned key, about the wallet, and fresh", async () => {
    const signed = await signSignal(signer);
    const result = await verifyPredgeSignal(signed, {
      requestedWallet: WALLET,
      expectedKeyId: signer.keyIdHex,
      now: NOW,
    });
    expect(result.verified).toBe(true);
    expect(result.reason).toBeUndefined();
    expect(result.subjectMatch).toBe(true);
    expect(result.signer).toBe(signer.keyIdHex);
  });

  it("rejects a signer that is not the pinned Predge key by default", async () => {
    // No expectedKeyId override, so the default pinned Predge key applies. A
    // signal minted with any other keypair must not verify -- this is the
    // responder-chooses-its-own-key hole, closed.
    const signed = await signSignal(signer);
    const result = await verifyPredgeSignal(signed, {
      requestedWallet: WALLET,
      now: NOW,
    });
    expect(result.verified).toBe(false);
    expect(result.reason).toMatch(/pinned Predge key/i);
  });

  it("rejects a signal signed by a different key than the pin", async () => {
    const attacker = await generateSigner();
    const signed = await signSignal(attacker);
    const result = await verifyPredgeSignal(signed, {
      requestedWallet: WALLET,
      expectedKeyId: signer.keyIdHex,
      now: NOW,
    });
    expect(result.verified).toBe(false);
    expect(result.reason).toMatch(/pinned Predge key/i);
  });

  it("rejects a tampered payload", async () => {
    const signed = await signSignal(signer);
    signed.attestation.payload.conviction = 99; // flip after signing
    const result = await verifyPredgeSignal(signed, {
      requestedWallet: WALLET,
      expectedKeyId: signer.keyIdHex,
      now: NOW,
    });
    expect(result.verified).toBe(false);
    expect(result.reason).toMatch(/signature does not match/i);
  });

  it("rejects a correctly signed signal about a different wallet", async () => {
    const other = "0x000000000000000000000000000000000000dead";
    const signed = await signSignal(signer, { wallet: other });
    const result = await verifyPredgeSignal(signed, {
      requestedWallet: WALLET,
      expectedKeyId: signer.keyIdHex,
      now: NOW,
    });
    expect(result.verified).toBe(false);
    expect(result.subjectMatch).toBe(false);
    expect(result.reason).toMatch(/different wallet/i);
  });

  it("rejects a stale attestation", async () => {
    const oldIssued = new Date(NOW - 3600_000).toISOString(); // 1h old
    const signed = await signSignal(signer, { issuedAt: oldIssued });
    const result = await verifyPredgeSignal(signed, {
      requestedWallet: WALLET,
      expectedKeyId: signer.keyIdHex,
      maxAgeSeconds: 600,
      now: NOW,
    });
    expect(result.verified).toBe(false);
    expect(result.reason).toMatch(/stale/i);
  });

  it("rejects an attestation issued in the future", async () => {
    const futureIssued = new Date(NOW + 5 * 60_000).toISOString();
    const signed = await signSignal(signer, { issuedAt: futureIssued });
    const result = await verifyPredgeSignal(signed, {
      requestedWallet: WALLET,
      expectedKeyId: signer.keyIdHex,
      now: NOW,
    });
    expect(result.verified).toBe(false);
    expect(result.reason).toMatch(/future/i);
  });

  it("matches wallets case-insensitively", async () => {
    const signed = await signSignal(signer, { wallet: WALLET.toLowerCase() });
    const result = await verifyPredgeSignal(signed, {
      requestedWallet: WALLET.toUpperCase().replace("0X", "0x"),
      expectedKeyId: signer.keyIdHex,
      now: NOW,
    });
    expect(result.verified).toBe(true);
  });

  it("verifies a captured live signal against the default pin, no override", async () => {
    // A real 200 from https://api.predge.io/v1/signal/<wallet>, signed by the
    // production attestation key. This exercises the hardcoded
    // DEFAULT_PINNED_SIGNER (no expectedKeyId passed) against Predge's real
    // bytes, so a wrong keyId form or a canonicalization drift from the real
    // signer would fail here rather than pass invisibly. `now` is pinned near
    // issuedAt so freshness does not reject a stored fixture.
    const LIVE: PredgeSignedAttestation = {
      attestation: {
        scheme: "veri402-ed25519-v1",
        resource: "conviction:0x0224bb9eb0a5c9fd261ac9123a72cbdd5748292a",
        payload: {
          wallet: "0x0224bb9eb0a5c9fd261ac9123a72cbdd5748292a",
          conviction: 100,
          action: "accumulate",
          window: "30d",
        },
        issuedAt: "2026-09-17T08:41:47.097Z",
        nonce: "478637d087a23312fe549b4217cf97ec",
        keyId:
          "13fa3d18a369e6c71bf941563ba47822b30182273d5106a0e8fb61c5016352d9",
      },
      signature:
        "b8e960636ed0badfcb26ca364e91ebaaffce0ccf10bc1364ae00b73497a10493d5ea007b57d27c776e3121ab353492d5e9a731348e7d1b8c1c18848cc609bf05",
    };
    const result = await verifyPredgeSignal(LIVE, {
      requestedWallet: "0x0224bb9eb0a5c9fd261ac9123a72cbdd5748292a",
      now: Date.parse(LIVE.attestation.issuedAt) + 1000,
    });
    expect(result.verified).toBe(true);
    expect(result.signer).toBe(
      "13fa3d18a369e6c71bf941563ba47822b30182273d5106a0e8fb61c5016352d9"
    );
    expect(result.subjectMatch).toBe(true);
  });

  it("returns a clean verified:false on a malformed body instead of throwing", async () => {
    const bad: PredgeSignedAttestation[] = [
      {} as unknown as PredgeSignedAttestation,
      { attestation: {} } as unknown as PredgeSignedAttestation,
      {
        attestation: { scheme: SCHEME, keyId: 123, payload: { wallet: WALLET } },
        signature: "00",
      } as unknown as PredgeSignedAttestation,
      {
        attestation: {
          scheme: SCHEME,
          keyId: signer.keyIdHex,
          payload: { wallet: 123 },
        },
        signature: "00",
      } as unknown as PredgeSignedAttestation,
    ];
    for (const b of bad) {
      const result = await verifyPredgeSignal(b, {
        requestedWallet: WALLET,
        now: NOW,
      });
      expect(result.verified).toBe(false);
      expect(result.reason).toMatch(/malformed/i);
    }
  });
});

describe("readSignalStep", () => {
  beforeEach(() => {
    mockFetchCredentials.mockReset();
    safeFetch.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function respondWith(signed: PredgeSignedAttestation) {
    safeFetch.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      json: () => Promise.resolve(signed),
    });
  }

  it("succeeds with a verified signal when the pin matches", async () => {
    mockFetchCredentials.mockResolvedValue({
      PREDGE_SIGNER_KEY_ID: signer.keyIdHex,
    });
    // Fresh issuedAt so the step's real-clock freshness check passes whenever
    // the suite runs.
    respondWith(await signSignal(signer, { issuedAt: new Date().toISOString() }));

    const out = (await readSignalStep({
      wallet: WALLET,
      integrationId: "int_1",
    } as never)) as {
      success: boolean;
      conviction: number;
      signer: string;
      wallet: string;
    };

    expect(out.success).toBe(true);
    expect(out.conviction).toBe(82);
    expect(out.signer).toBe(signer.keyIdHex);
    expect(out.wallet).toBe(WALLET);
  });

  it("fails the step, not the data, when verification does not hold", async () => {
    // No credentials, so the default Predge pin applies and the test-key
    // signature is rejected. The step must error rather than return success
    // with an unverified payload beside it.
    mockFetchCredentials.mockResolvedValue({});
    respondWith(await signSignal(signer, { issuedAt: new Date().toISOString() }));

    const out = (await readSignalStep({
      wallet: WALLET,
      integrationId: "int_1",
    } as never)) as { success: boolean; error: string };

    expect(out.success).toBe(false);
    expect(out.error).toMatch(/did not verify/i);
    expect(out.error).toMatch(/pinned Predge key/i);
  });

  it("fails cleanly on a malformed 200 body rather than throwing", async () => {
    mockFetchCredentials.mockResolvedValue({});
    safeFetch.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      json: () => Promise.resolve({}), // 200 with an empty body
    });

    const out = (await readSignalStep({
      wallet: WALLET,
      integrationId: "int_1",
    } as never)) as { success: boolean; error: string };

    expect(out.success).toBe(false);
    expect(out.error).toMatch(/malformed/i);
  });

  it("surfaces a wallet-required error before any fetch", async () => {
    mockFetchCredentials.mockResolvedValue({});
    const out = (await readSignalStep({
      wallet: "   ",
      integrationId: "int_1",
    } as never)) as { success: boolean; error: string };

    expect(out.success).toBe(false);
    expect(out.error).toMatch(/wallet address is required/i);
    expect(safeFetch).not.toHaveBeenCalled();
  });
});
