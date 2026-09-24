import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

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

import { ExecutionErrorType } from "@/lib/errors/execution-error-type";
import {
  canonicalize,
  type PredgeSignedAttestation,
  verifyPredgeSignal,
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
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
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
  resource?: string; // force a resource other than conviction:<wallet>
  // Replace the whole payload, so a test can sign a body the declared type
  // forbids. The point of these cases is that the signature is valid and the
  // contents still are not what the step promises.
  payload?: Record<string, unknown>;
};

async function signSignal(
  signer: Signer,
  overrides: SignalOverrides = {}
): Promise<PredgeSignedAttestation> {
  const attestation = {
    scheme: SCHEME,
    resource:
      overrides.resource ??
      `conviction:${(overrides.wallet ?? WALLET).toLowerCase()}`,
    payload: overrides.payload ?? {
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
  return {
    attestation,
    signature: toHex(signature),
  } as PredgeSignedAttestation;
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
    const oldIssued = new Date(NOW - 3_600_000).toISOString(); // 1h old
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
        attestation: {
          scheme: SCHEME,
          keyId: 123,
          payload: { wallet: WALLET },
        },
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

  // The step reads the body as text and parses it itself (size cap first), so
  // the mock has to answer the way a real Response does rather than handing
  // back a pre-parsed object.
  function respondWithBody(body: string, headers: Record<string, string> = {}) {
    safeFetch.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers(headers),
      text: () => Promise.resolve(body),
    });
  }

  function respondWith(signed: PredgeSignedAttestation) {
    respondWithBody(JSON.stringify(signed));
  }

  function respondWithStatus(status: number, statusText = "") {
    safeFetch.mockResolvedValue({
      ok: false,
      status,
      statusText,
      headers: new Headers(),
      text: () => Promise.resolve(""),
    });
  }

  // A correctly signed envelope whose payload carries `body` verbatim, minted
  // with the key the step is told to pin. Signature valid, contents arbitrary:
  // exactly the case the shape checks exist for.
  async function signedPayload(body: Record<string, unknown>) {
    mockFetchCredentials.mockResolvedValue({
      PREDGE_SIGNER_KEY_ID: signer.keyIdHex,
    });
    respondWith(
      await signSignal(signer, {
        payload: body,
        issuedAt: new Date().toISOString(),
      })
    );
  }

  async function runStep() {
    return (await readSignalStep({
      wallet: WALLET,
      integrationId: "int_1",
    } as never)) as {
      success: boolean;
      error?: string;
      errorClass?: string;
      conviction?: unknown;
      action?: unknown;
      window?: unknown;
    };
  }

  it("succeeds with a verified signal when the pin matches", async () => {
    mockFetchCredentials.mockResolvedValue({
      PREDGE_SIGNER_KEY_ID: signer.keyIdHex,
    });
    // Fresh issuedAt so the step's real-clock freshness check passes whenever
    // the suite runs.
    respondWith(
      await signSignal(signer, { issuedAt: new Date().toISOString() })
    );

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
    respondWith(
      await signSignal(signer, { issuedAt: new Date().toISOString() })
    );

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
    respondWithBody("{}"); // 200 with an empty body

    const out = (await readSignalStep({
      wallet: WALLET,
      integrationId: "int_1",
    } as never)) as { success: boolean; error: string };

    expect(out.success).toBe(false);
    expect(out.error).toMatch(/malformed/i);
  });

  // Attribution, not retry behaviour: a failure the operator's own config
  // produced should not be filed against Predge's uptime. The same two reasons
  // stay EXTERNAL when the operator configured nothing, because then they are
  // genuinely the upstream's doing.
  it("blames the operator for a pin mismatch only when they set the key id", async () => {
    mockFetchCredentials.mockResolvedValue({
      PREDGE_SIGNER_KEY_ID: "deadbeef",
    });
    respondWith(
      await signSignal(signer, { issuedAt: new Date().toISOString() })
    );

    const out = (await readSignalStep({
      wallet: WALLET,
      integrationId: "int_1",
    } as never)) as { success: boolean; errorClass: string };

    expect(out.success).toBe(false);
    expect(out.errorClass).toBe(ExecutionErrorType.USER);
  });

  it("blames Predge for a pin mismatch when the operator set nothing", async () => {
    mockFetchCredentials.mockResolvedValue({});
    respondWith(
      await signSignal(signer, { issuedAt: new Date().toISOString() })
    );

    const out = (await readSignalStep({
      wallet: WALLET,
      integrationId: "int_1",
    } as never)) as { success: boolean; errorClass: string };

    expect(out.success).toBe(false);
    expect(out.errorClass).toBe(ExecutionErrorType.EXTERNAL);
  });

  it("blames the operator for a malformed body only when they repointed the host", async () => {
    mockFetchCredentials.mockResolvedValue({
      PREDGE_SIGNAL_URL: "https://signals.example.internal",
    });
    respondWithBody("{}");

    const out = (await readSignalStep({
      wallet: WALLET,
      integrationId: "int_1",
    } as never)) as { success: boolean; errorClass: string };

    expect(out.success).toBe(false);
    expect(out.errorClass).toBe(ExecutionErrorType.USER);
  });

  it("blames Predge for a malformed body from the default host", async () => {
    mockFetchCredentials.mockResolvedValue({});
    respondWithBody("{}");

    const out = (await readSignalStep({
      wallet: WALLET,
      integrationId: "int_1",
    } as never)) as { success: boolean; errorClass: string };

    expect(out.success).toBe(false);
    expect(out.errorClass).toBe(ExecutionErrorType.EXTERNAL);
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

  // The four reproductions from review, each run against the real step with the
  // real verifier and a correctly signed envelope. The signature holds in every
  // one of them: what fails is the shape of what it vouches for. Nothing is
  // coerced, and the error names the field, what arrived and what was expected.
  describe("payload shape, on a correctly signed envelope", () => {
    const GOOD = {
      wallet: WALLET,
      conviction: 82,
      action: "accumulate",
      window: "30d",
    };

    it("rejects a conviction that is a numeric string", async () => {
      await signedPayload({ ...GOOD, conviction: "99999" });
      const out = await runStep();

      // "99999" >= 80 coerces true in a template gate, so returning it at all
      // is the bug; the step must not return it as a string or as a number.
      expect(out.success).toBe(false);
      expect(out.conviction).toBeUndefined();
      expect(out.error).toMatch(/conviction/i);
      expect(out.error).toMatch(/finite number in 0-100/i);
      expect(out.error).toMatch(/string "99999"/);
    });

    it("rejects a missing conviction instead of succeeding without one", async () => {
      const { conviction: _omitted, ...withoutConviction } = GOOD;
      await signedPayload(withoutConviction);
      const out = await runStep();

      // The silent case: success with no conviction key renders empty in a
      // template and never fires a `conviction < 30` branch.
      expect(out.success).toBe(false);
      expect(out.error).toMatch(/conviction/i);
      expect(out.error).toMatch(/missing/i);
    });

    it("rejects an action that is an object", async () => {
      await signedPayload({ ...GOOD, action: { evil: 1 } });
      const out = await runStep();

      expect(out.success).toBe(false);
      expect(out.action).toBeUndefined();
      expect(out.error).toMatch(
        /action must be one of accumulate, reduce, hold/i
      );
      expect(out.error).toMatch(/got object/i);
    });

    it("rejects a conviction below the documented range", async () => {
      await signedPayload({ ...GOOD, conviction: -500 });
      const out = await runStep();

      expect(out.success).toBe(false);
      expect(out.error).toMatch(/conviction must be in 0-100/i);
      expect(out.error).toMatch(/got number -500/);
    });

    it("rejects a conviction above the documented range", async () => {
      await signedPayload({ ...GOOD, conviction: 101 });
      const out = await runStep();

      expect(out.success).toBe(false);
      expect(out.error).toMatch(/conviction must be in 0-100/i);
    });

    it("rejects a non-finite conviction", async () => {
      // JSON has no NaN, so this arrives as null from a real host; either way it
      // is not a number the gate can compare.
      await signedPayload({ ...GOOD, conviction: null });
      const out = await runStep();

      expect(out.success).toBe(false);
      expect(out.error).toMatch(/conviction/i);
      expect(out.error).toMatch(/got null/i);
    });

    it("rejects an unrecognised window", async () => {
      await signedPayload({ ...GOOD, window: "90d" });
      const out = await runStep();

      expect(out.success).toBe(false);
      expect(out.error).toMatch(/window must be one of 7d, 30d/i);
      expect(out.error).toMatch(/string "90d"/);
    });

    it("rejects an unrecognised action string", async () => {
      await signedPayload({ ...GOOD, action: "liquidate" });
      const out = await runStep();

      expect(out.success).toBe(false);
      expect(out.error).toMatch(/action must be one of/i);
    });

    it("accepts the documented shape at both ends of the range", async () => {
      for (const conviction of [0, 100]) {
        await signedPayload({ ...GOOD, conviction });
        const out = await runStep();
        expect(out.success).toBe(true);
        expect(out.conviction).toBe(conviction);
      }
    });

    it("still passes a well-formed signed envelope through unchanged", async () => {
      await signedPayload(GOOD);
      const out = await runStep();

      expect(out.success).toBe(true);
      expect(out.conviction).toBe(82);
      expect(typeof out.conviction).toBe("number");
      expect(out.action).toBe("accumulate");
      expect(out.window).toBe("30d");
    });

    it("blames Predge for a bad payload from the default host, the operator for their own", async () => {
      await signedPayload({ ...GOOD, conviction: "99999" });
      expect((await runStep()).errorClass).toBe(ExecutionErrorType.EXTERNAL);

      mockFetchCredentials.mockResolvedValue({
        PREDGE_SIGNER_KEY_ID: signer.keyIdHex,
        PREDGE_SIGNAL_URL: "https://signals.example.com",
      });
      expect((await runStep()).errorClass).toBe(ExecutionErrorType.USER);
    });
  });

  // Domain separation. `resource` is signed and was never read, so the only
  // thing telling a conviction signal apart from another attestation the same
  // key signed about the same wallet was the payload's field names.
  describe("resource binding", () => {
    it("rejects another signed product about the same wallet", async () => {
      mockFetchCredentials.mockResolvedValue({
        PREDGE_SIGNER_KEY_ID: signer.keyIdHex,
      });
      // A track-record envelope: same scheme, same key, same wallet, different
      // product and different payload fields.
      respondWith(
        await signSignal(signer, {
          resource: `track-record:${WALLET.toLowerCase()}`,
          payload: {
            wallet: WALLET,
            conviction_score: 91,
            verdict: "strong",
          },
          issuedAt: new Date().toISOString(),
        })
      );

      const out = await runStep();
      expect(out.success).toBe(false);
      expect(out.error).toMatch(/track-record:/);
      expect(out.error).toMatch(/expected "conviction:/);
    });

    it("rejects a conviction resource naming a different wallet", async () => {
      mockFetchCredentials.mockResolvedValue({
        PREDGE_SIGNER_KEY_ID: signer.keyIdHex,
      });
      respondWith(
        await signSignal(signer, {
          resource: "conviction:0x000000000000000000000000000000000000dead",
          issuedAt: new Date().toISOString(),
        })
      );

      const out = await runStep();
      expect(out.success).toBe(false);
      expect(out.error).toMatch(/expected "conviction:/);
    });

    it("blames the operator for a foreign resource only when they repointed the host", async () => {
      // A real Predge signature over another product is the same mistake as a
      // body that was never a Predge response, one layer in, so it is filed on
      // the same side of the fence.
      mockFetchCredentials.mockResolvedValue({
        PREDGE_SIGNER_KEY_ID: signer.keyIdHex,
      });
      respondWith(
        await signSignal(signer, {
          resource: `track-record:${WALLET.toLowerCase()}`,
          issuedAt: new Date().toISOString(),
        })
      );
      expect((await runStep()).errorClass).toBe(ExecutionErrorType.EXTERNAL);

      mockFetchCredentials.mockResolvedValue({
        PREDGE_SIGNER_KEY_ID: signer.keyIdHex,
        PREDGE_SIGNAL_URL: "https://signals.example.com",
      });
      expect((await runStep()).errorClass).toBe(ExecutionErrorType.USER);
    });
  });

  // Every non-200 branch of fetchSignedSignal, which the suite used to leave
  // unasserted: they did fail closed, nothing held them to it.
  describe("non-200 responses", () => {
    beforeEach(() => {
      mockFetchCredentials.mockResolvedValue({});
    });

    it("reports a 404 as no signal for the wallet, blamed on the caller", async () => {
      respondWithStatus(404, "Not Found");
      const out = await runStep();
      expect(out.success).toBe(false);
      expect(out.error).toMatch(/no predge signal for this wallet/i);
      expect(out.errorClass).toBe(ExecutionErrorType.USER);
    });

    it("reports a 402 as the wrong endpoint for this plugin", async () => {
      respondWithStatus(402, "Payment Required");
      const out = await runStep();
      expect(out.success).toBe(false);
      expect(out.error).toMatch(/requires payment/i);
      expect(out.errorClass).toBe(ExecutionErrorType.USER);
    });

    it("treats a 429 as the upstream's, not the author's configuration", async () => {
      respondWithStatus(429, "Too Many Requests");
      const out = await runStep();
      expect(out.success).toBe(false);
      expect(out.error).toMatch(/rate limiting/i);
      expect(out.errorClass).toBe(ExecutionErrorType.EXTERNAL);
    });

    it("surfaces a 500 as the upstream's", async () => {
      respondWithStatus(500, "Internal Server Error");
      const out = await runStep();
      expect(out.success).toBe(false);
      expect(out.error).toMatch(/HTTP 500/);
      expect(out.errorClass).toBe(ExecutionErrorType.EXTERNAL);
    });

    it("surfaces an unexpected 4xx as the caller's", async () => {
      respondWithStatus(418, "I'm a teapot");
      const out = await runStep();
      expect(out.success).toBe(false);
      expect(out.error).toMatch(/HTTP 418/);
      expect(out.errorClass).toBe(ExecutionErrorType.USER);
    });

    it("fails closed on a body that is not JSON", async () => {
      respondWithBody("<html>proxy error</html>");
      const out = await runStep();
      expect(out.success).toBe(false);
      expect(out.error).toMatch(/not valid JSON/i);
    });

    it("refuses an oversized body on its declared length, before reading it", async () => {
      const text = vi.fn(() => Promise.resolve("{}"));
      safeFetch.mockResolvedValue({
        ok: true,
        status: 200,
        statusText: "OK",
        headers: new Headers({ "content-length": String(10 * 1024 * 1024) }),
        text,
      });

      const out = await runStep();
      expect(out.success).toBe(false);
      expect(out.error).toMatch(/over the .* byte limit/i);
      expect(text).not.toHaveBeenCalled();
    });

    it("refuses an oversized body that did not declare its length", async () => {
      respondWithBody("x".repeat(64 * 1024 + 1));
      const out = await runStep();
      expect(out.success).toBe(false);
      expect(out.error).toMatch(/byte limit/i);
    });

    it("reports a blocked SSRF target as the operator's configuration", async () => {
      mockFetchCredentials.mockResolvedValue({
        PREDGE_SIGNAL_URL: "http://169.254.169.254",
      });
      const safeFetchModule = await import("@/lib/safe-fetch");
      // The mock replaces SsrfBlockedError with a plain Error subclass, so its
      // constructor takes a message where the real one takes a details object.
      const MockSsrfBlockedError =
        safeFetchModule.SsrfBlockedError as unknown as new (
          message: string
        ) => Error;
      vi.mocked(safeFetchModule.assertUrlIsPublic).mockRejectedValueOnce(
        new MockSsrfBlockedError("link-local address")
      );

      const out = await runStep();
      expect(out.success).toBe(false);
      expect(out.error).toMatch(/not allowed/i);
      expect(out.errorClass).toBe(ExecutionErrorType.USER);
      expect(safeFetch).not.toHaveBeenCalled();
    });

    it("blames the operator for a signal URL that does not parse", async () => {
      mockFetchCredentials.mockResolvedValue({
        PREDGE_SIGNAL_URL: "api.predge.io",
      });

      const out = await runStep();
      expect(out.success).toBe(false);
      expect(out.error).toMatch(/not a valid URL/i);
      expect(out.errorClass).toBe(ExecutionErrorType.USER);
      expect(safeFetch).not.toHaveBeenCalled();
    });
  });
});
