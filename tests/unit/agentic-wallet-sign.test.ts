/**
 * Wave 0 RED scaffold for lib/agentic-wallet/sign.ts.
 *
 * Contract anchors:
 *   - 33-RESEARCH.md Pattern 3 (lines 367-444) -- x402 EIP-3009 signing shape
 *   - 33-RESEARCH.md Pattern 4 (lines 448-470) -- MPP proof-mode EIP-712
 *   - 33-RESEARCH.md Pitfall 7 -- CONSENSUS_NEEDED maps to POLICY_BLOCKED
 *
 * The helpers must call Turnkey signRawPayload with PAYLOAD_ENCODING_EIP712 +
 * HASH_FUNCTION_NO_OP and return a 132-char 0x-prefixed 65-byte signature
 * (v-parity bumped by 27 per @turnkey/ethers::serializeSignature).
 *
 * Baseline: every case throws because both helpers are stubs. Plan 33-02
 * flips this suite GREEN.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockSignRawPayload } = vi.hoisted(() => ({
  mockSignRawPayload: vi.fn(),
}));

vi.mock("@turnkey/sdk-server", () => ({
  // Named function expression (not an arrow) so `new Turnkey(...)` is
  // constructable under vitest 4.x. Arrow fns lack [[Construct]] and throw
  // "is not a constructor". See 33-01a summary deviation #2 for the same fix.
  Turnkey: vi.fn(function TurnkeyMock(this: unknown): {
    apiClient: () => { signRawPayload: typeof mockSignRawPayload };
  } {
    return {
      apiClient: (): { signRawPayload: typeof mockSignRawPayload } => ({
        signRawPayload: mockSignRawPayload,
      }),
    };
  }),
}));

const {
  PolicyBlockedError,
  signMppProof,
  signMppTransaction,
  signX402Challenge,
} = await import("@/lib/agentic-wallet/sign");

const { Challenge } = await import("mppx");

const SUB_ORG = "subOrg_sign_test";
const WALLET = "0xabc000000000000000000000000000000000dead";
const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

const MPP_TEST_SECRET = "test-secret-key-for-mpp-challenge-signing";

/**
 * Build a mppx-serialized Tempo charge challenge and return the
 * parameters string (without the `Payment ` scheme prefix) that the npm
 * client would forward to /sign as `paymentChallenge.serialized`. Using the
 * real Challenge.from + Challenge.serialize path keeps the test aligned
 * with whatever shape mppx ships.
 */
function buildTempoChallengeSerialized(): string {
  const challenge = Challenge.from({
    secretKey: MPP_TEST_SECRET,
    realm: "test.keeperhub.local",
    method: "tempo",
    intent: "charge",
    request: {
      amount: "10000",
      currency: "0x20c000000000000000000000b9537d11c60e8b50",
      recipient: "0x000000000000000000000000000000000000dead",
      methodDetails: { chainId: 4217 },
    },
  });
  const full = Challenge.serialize(challenge);
  return full.startsWith("Payment ") ? full.slice("Payment ".length) : full;
}

function happyPathResult(v: "00" | "01"): Record<string, unknown> {
  return {
    activity: {
      status: "ACTIVITY_STATUS_COMPLETED",
      result: {
        signRawPayloadResult: {
          // r is arbitrary 32 bytes. s MUST be canonical (low-s per EIP-2);
          // the secp256k1 half-order is ~0x7FFF...5D57..., so all-"bb"
          // (0xbb...) is high-s and ethers 6 rejects it with "non-canonical
          // s". Use "11".repeat(32) — safely below the half-order boundary.
          r: "aa".repeat(32),
          s: "11".repeat(32),
          v,
        },
      },
    },
  };
}

describe("signX402Challenge", () => {
  beforeEach(() => {
    process.env.TURNKEY_API_PUBLIC_KEY = "test-pub";
    process.env.TURNKEY_API_PRIVATE_KEY = "test-priv";
    process.env.TURNKEY_ORGANIZATION_ID = "org_test";
    mockSignRawPayload.mockReset();
    mockSignRawPayload.mockResolvedValue(happyPathResult("00"));
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("calls signRawPayload with flat EIP-712 args (Turnkey SDK v5.3.0 contract)", async () => {
    await signX402Challenge(SUB_ORG, WALLET, {
      payTo: "0x1111111111111111111111111111111111111111",
      amount: "1000000",
      validAfter: 0,
      validBefore: Math.floor(Date.now() / 1000) + 600,
      nonce: `0x${"11".repeat(32)}`,
    });
    expect(mockSignRawPayload).toHaveBeenCalledTimes(1);
    const args = mockSignRawPayload.mock.calls[0]?.[0];
    expect(args.signWith).toBe(WALLET);
    expect(args.encoding).toBe("PAYLOAD_ENCODING_EIP712");
    expect(args.hashFunction).toBe("HASH_FUNCTION_NO_OP");
  });

  it("serialises typed data with chainId 8453, Base USDC verifying contract, and primaryType TransferWithAuthorization", async () => {
    await signX402Challenge(SUB_ORG, WALLET, {
      payTo: "0x1111111111111111111111111111111111111111",
      amount: "1000000",
      validAfter: 0,
      validBefore: 1,
      nonce: `0x${"11".repeat(32)}`,
    });
    const args = mockSignRawPayload.mock.calls[0]?.[0];
    const typedData = JSON.parse(args.payload) as {
      domain: { chainId: number; verifyingContract: string };
      types: Record<string, unknown>;
      primaryType: string;
      message: Record<string, unknown>;
    };
    expect(typedData.domain.chainId).toBe(8453);
    expect(typedData.domain.verifyingContract).toBe(BASE_USDC);
    expect(typedData.primaryType).toBe("TransferWithAuthorization");
    expect(typedData.types).toBeDefined();
    expect(typedData.message).toBeDefined();
  });

  it("returns a 0x-prefixed 132-char (65-byte) signature string", async () => {
    const sig = await signX402Challenge(SUB_ORG, WALLET, {
      payTo: "0x1111111111111111111111111111111111111111",
      amount: "1000000",
      validAfter: 0,
      validBefore: 1,
      nonce: `0x${"11".repeat(32)}`,
    });
    expect(sig.startsWith("0x")).toBe(true);
    expect(sig.length).toBe(132);
  });

  it("maps Turnkey v:'00' to trailing 1b (v+27 = 27 = 0x1b)", async () => {
    mockSignRawPayload.mockResolvedValueOnce(happyPathResult("00"));
    const sig = await signX402Challenge(SUB_ORG, WALLET, {
      payTo: "0x1111111111111111111111111111111111111111",
      amount: "1000000",
      validAfter: 0,
      validBefore: 1,
      nonce: `0x${"11".repeat(32)}`,
    });
    expect(sig.slice(-2)).toBe("1b");
  });

  it("maps Turnkey v:'01' to trailing 1c (v+27 = 28 = 0x1c)", async () => {
    mockSignRawPayload.mockResolvedValueOnce(happyPathResult("01"));
    const sig = await signX402Challenge(SUB_ORG, WALLET, {
      payTo: "0x1111111111111111111111111111111111111111",
      amount: "1000000",
      validAfter: 0,
      validBefore: 1,
      nonce: `0x${"11".repeat(32)}`,
    });
    expect(sig.slice(-2)).toBe("1c");
  });

  it("throws PolicyBlockedError when Turnkey responds with ACTIVITY_STATUS_CONSENSUS_NEEDED", async () => {
    mockSignRawPayload.mockResolvedValueOnce({
      activity: { status: "ACTIVITY_STATUS_CONSENSUS_NEEDED" },
    });
    // Callers (including the /sign route) discriminate via
    // `instanceof PolicyBlockedError`, not by substring-matching .message.
    // The HTTP `code: "POLICY_BLOCKED"` response is asserted separately in
    // tests/integration/agentic-wallet-sign-route.test.ts.
    await expect(
      signX402Challenge(SUB_ORG, WALLET, {
        payTo: "0x1111111111111111111111111111111111111111",
        amount: "1000000",
        validAfter: 0,
        validBefore: 1,
        nonce: `0x${"11".repeat(32)}`,
      })
    ).rejects.toBeInstanceOf(PolicyBlockedError);
  });
});

describe("signMppProof", () => {
  beforeEach(() => {
    process.env.TURNKEY_API_PUBLIC_KEY = "test-pub";
    process.env.TURNKEY_API_PRIVATE_KEY = "test-priv";
    process.env.TURNKEY_ORGANIZATION_ID = "org_test";
    mockSignRawPayload.mockReset();
    mockSignRawPayload.mockResolvedValue(happyPathResult("00"));
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("serialises typed data with chainId 4217 and primaryType Proof (Tempo proof-mode)", async () => {
    await signMppProof(SUB_ORG, WALLET, {
      chainId: 4217,
      serialized: buildTempoChallengeSerialized(),
    });
    const args = mockSignRawPayload.mock.calls[0]?.[0];
    expect(args.encoding).toBe("PAYLOAD_ENCODING_EIP712");
    const typedData = JSON.parse(args.payload) as {
      domain: { chainId: number };
      primaryType: string;
      message: { challengeId: string };
    };
    expect(typedData.domain.chainId).toBe(4217);
    expect(typedData.primaryType).toBe("Proof");
    // challengeId comes from the parsed Challenge.id (HMAC-bound), not a
    // caller-supplied field. Any non-empty string means the parse+sign path
    // ran against real mppx-issued challenge data.
    expect(typedData.message.challengeId).toBeTruthy();
    expect(typeof typedData.message.challengeId).toBe("string");
  });

  it("returns a serialized Credential envelope, not the raw 0x signature", async () => {
    const out = await signMppProof(SUB_ORG, WALLET, {
      chainId: 4217,
      serialized: buildTempoChallengeSerialized(),
    });
    // Not the raw EIP-712 signature -- that would shape-fail the facilitator
    // with "Credential is malformed". The return value is the encoded portion
    // of what mppx's `Credential.serialize()` emits (the `Payment ` scheme
    // token is stripped so callers can prepend it themselves).
    expect(out.startsWith("0x")).toBe(false);
    expect(out.startsWith("Payment ")).toBe(false);
    // Decoding back yields a Credential with `{challenge, payload:{type, signature}}`.
    const decoded = JSON.parse(
      Buffer.from(out, "base64url").toString("utf-8")
    ) as {
      challenge: { id: string };
      payload: { type: string; signature: string };
    };
    expect(decoded.challenge.id).toBeTruthy();
    // `type` is the discriminator mppx Methods.charge.schema.credential.payload
    // expects. Proof-mode sigs are `type: "proof"`.
    expect(decoded.payload.type).toBe("proof");
    expect(decoded.payload.signature.startsWith("0x")).toBe(true);
    expect(decoded.payload.signature.length).toBe(132);
  });
});

describe("signMppTransaction", () => {
  beforeEach(() => {
    process.env.TURNKEY_API_PUBLIC_KEY = "test-pub";
    process.env.TURNKEY_API_PRIVATE_KEY = "test-priv";
    process.env.TURNKEY_ORGANIZATION_ID = "org_test";
    mockSignRawPayload.mockReset();
    mockSignRawPayload.mockResolvedValue(happyPathResult("00"));
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("signs a raw hex hash (not EIP-712 JSON) for charge intent", async () => {
    const serialized = buildTempoChallengeSerialized();
    await signMppTransaction(SUB_ORG, WALLET, {
      chainId: 4217,
      serialized,
    });
    const args = mockSignRawPayload.mock.calls[0]?.[0] as {
      encoding: string;
      hashFunction: string;
      payload: string;
    };
    // Different from proof-mode: we pre-compute the Tempo sighash client-side
    // and hand it to Turnkey as a raw hex payload.
    expect(args.encoding).toBe("PAYLOAD_ENCODING_HEXADECIMAL");
    expect(args.hashFunction).toBe("HASH_FUNCTION_NO_OP");
    // 32-byte hex hash -> "0x" + 64 chars.
    expect(args.payload.startsWith("0x")).toBe(true);
    expect(args.payload.length).toBe(66);
  });

  it("wraps the signed 0x76 Tempo tx in a Credential with the right source DID", async () => {
    const out = await signMppTransaction(SUB_ORG, WALLET, {
      chainId: 4217,
      serialized: buildTempoChallengeSerialized(),
    });
    expect(out.startsWith("Payment ")).toBe(false);
    expect(out.startsWith("0x")).toBe(false);
    const decoded = JSON.parse(
      Buffer.from(out, "base64url").toString("utf-8")
    ) as {
      challenge: { id: string };
      payload: { type: string; signature: string };
      source?: string;
    };
    expect(decoded.challenge.id).toBeTruthy();
    // `type` is the discriminator mppx Methods.charge.schema.credential.payload
    // expects. Tx-mode is `type: "transaction"`.
    expect(decoded.payload.type).toBe("transaction");
    // payload.signature is the serialized Tempo tx -- starts with 0x76
    // (TxEnvelopeTempo.serializedType), NOT a raw 132-char ECDSA sig.
    expect(decoded.payload.signature.startsWith("0x76")).toBe(true);
    // source binds the credential to the wallet on Tempo mainnet.
    expect(decoded.source).toBe(`did:pkh:eip155:4217:${WALLET}`);
  });

  it("uses the TIP-1009 expiring-nonce marker (nonceKey=uint256.max, nonce=0)", async () => {
    // Regression guard for the second MPP hotfix. Tempo's fee-payer path
    // only co-signs envelopes with the expiring-nonce marker; any other
    // nonceKey causes the facilitator to throw a non-PaymentError that mppx
    // wraps as a reason-less "Payment verification failed" 402. This mirrors
    // what `prepareTransactionRequest({nonceKey: 'expiring'})` produces in
    // mppx/client/Charge.js.
    const { TxEnvelopeTempo } = await import("ox/tempo");
    const out = await signMppTransaction(SUB_ORG, WALLET, {
      chainId: 4217,
      serialized: buildTempoChallengeSerialized(),
    });
    const decoded = JSON.parse(
      Buffer.from(out, "base64url").toString("utf-8")
    ) as { payload: { signature: `0x76${string}` } };
    const envelope = TxEnvelopeTempo.deserialize(decoded.payload.signature);
    const MAX_UINT256 = (BigInt(1) << BigInt(256)) - BigInt(1);
    expect(envelope.nonceKey).toBe(MAX_UINT256);
    expect(envelope.nonce).toBe(BigInt(0));
  });

  it("encodes the attribution memo identically to mppx Attribution.encode", async () => {
    // Regression guard for the fourth MPP hotfix. The original /sign hardcoded
    // the memo tag as ASCII "MPP\0" (0x4d505000). The real mppx tag is
    // keccak256("mpp")[0..3] = 0xef1ed712 (mppx/tempo/Attribution.js:31). With
    // the wrong tag, the post-broadcast assertChallengeBoundMemo check threw
    // a non-PaymentError that the facilitator's outer catch wrapped as a
    // reason-less "Payment verification failed" 402 -- same generic shape as
    // the previous three hotfixes. This test pins the memo bytes to whatever
    // mppx's own Attribution.encode produces for the same (challengeId,
    // serverId), so any future drift gets caught before deploy.
    const { TxEnvelopeTempo } = await import("ox/tempo");
    const { decodeFunctionData, keccak256, toBytes } = await import("viem");
    const { Abis } = await import("viem/tempo");

    // Spec-equivalent reimplementation of mppx/tempo/Attribution.encode using
    // viem primitives directly. We can't import mppx's Attribution at runtime
    // (package.json exports map omits the submodule), so we mirror its logic
    // here. Any divergence between this and the on-chain check is caught by
    // the byte-level equality assertion below.
    const mppxEncode = (params: {
      challengeId: string;
      serverId: string;
    }): `0x${string}` => {
      const tag = keccak256(toBytes("mpp")).slice(2, 10); // 4 bytes hex
      const serverFingerprint = keccak256(toBytes(params.serverId)).slice(
        2,
        22
      ); // 10 bytes hex
      const challengeFingerprint = keccak256(toBytes(params.challengeId)).slice(
        2,
        16
      ); // 7 bytes hex
      const version = "01";
      const clientId = "00000000000000000000"; // 10 bytes anonymous
      return `0x${tag}${version}${serverFingerprint}${clientId}${challengeFingerprint}`;
    };

    const fullChallenge = Challenge.from({
      secretKey: MPP_TEST_SECRET,
      realm: "test.keeperhub.local",
      method: "tempo",
      intent: "charge",
      request: {
        amount: "10000",
        currency: "0x20c000000000000000000000b9537d11c60e8b50",
        recipient: "0x000000000000000000000000000000000000dead",
        methodDetails: { chainId: 4217 },
      },
    });
    const serializedChallenge = Challenge.serialize(fullChallenge);
    const stripped = serializedChallenge.startsWith("Payment ")
      ? serializedChallenge.slice("Payment ".length)
      : serializedChallenge;

    const out = await signMppTransaction(SUB_ORG, WALLET, {
      chainId: 4217,
      serialized: stripped,
    });
    const decoded = JSON.parse(
      Buffer.from(out, "base64url").toString("utf-8")
    ) as { payload: { signature: `0x76${string}` } };
    const envelope = TxEnvelopeTempo.deserialize(decoded.payload.signature);
    const call = envelope.calls?.[0];
    if (!call?.data) {
      throw new Error("envelope has no call data");
    }
    const { args } = decodeFunctionData({
      abi: Abis.tip20,
      data: call.data,
    });
    const ourMemo = args[2] as `0x${string}`;
    const expectedMemo = mppxEncode({
      challengeId: fullChallenge.id,
      serverId: fullChallenge.realm,
    });
    expect(ourMemo.toLowerCase()).toBe(expectedMemo.toLowerCase());
    // Pin the tag bytes explicitly so a regression on just the tag (the
    // historic bug) surfaces with a clearer failure than a 32-byte diff.
    expect(ourMemo.slice(0, 10).toLowerCase()).toBe("0xef1ed712");
  });

  it("throws on non-charge intent (proof-mode belongs in signMppProof)", async () => {
    const zeroAmount = Challenge.serialize(
      Challenge.from({
        secretKey: MPP_TEST_SECRET,
        realm: "test.keeperhub.local",
        method: "tempo",
        intent: "session",
        request: {
          amount: "0",
          currency: "0x20c000000000000000000000b9537d11c60e8b50",
          recipient: "0x000000000000000000000000000000000000dead",
          methodDetails: { chainId: 4217 },
        },
      })
    );
    const serialized = zeroAmount.startsWith("Payment ")
      ? zeroAmount.slice("Payment ".length)
      : zeroAmount;
    await expect(
      signMppTransaction(SUB_ORG, WALLET, { chainId: 4217, serialized })
    ).rejects.toThrow(/charge only/);
  });
});
