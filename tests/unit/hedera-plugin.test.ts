import { beforeEach, describe, expect, it, vi } from "vitest";

import { assertUrlIsPublic, SsrfBlockedError } from "@/lib/safe-fetch";

const { safeFetchMock } = vi.hoisted(() => ({
  safeFetchMock: vi.fn(),
}));

// The real SsrfBlockedError takes a params object; the mocked class must
// accept the same shape so `new SsrfBlockedError({...})` in tests type-checks
// against the mocked module's exported class.
vi.mock("@/lib/safe-fetch", () => ({
  safeFetch: safeFetchMock,
  assertUrlIsPublic: vi.fn().mockResolvedValue(undefined),
  SsrfBlockedError: class SsrfBlockedError extends Error {
    name = "SsrfBlockedError";
    constructor(params: { hostname: string; reason: unknown; message: string }) {
      super(params.message);
    }
  },
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/workflow/executor/step-handler", async () =>
  (await import("../mocks/step-mocks")).stepHandlerPassthrough()
);
vi.mock("@/lib/metrics/instrumentation/plugin", async () =>
  (await import("../mocks/step-mocks")).pluginMetricsPassthrough()
);

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

function mirrorOk(body: {
  message?: string;
  consensus_timestamp?: string;
  sequence_number?: number | string;
  topic_id?: string;
  payer_account_id?: string;
  chunk_info?: { total?: number };
}) {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(body),
  };
}

function mirror404() {
  return {
    ok: false,
    status: 404,
    text: async () =>
      JSON.stringify({ _status: { messages: [{ message: "Not found" }] } }),
  };
}

// Mirror message bodies always echo the topic they describe; tests below rely
// on that echo matching the requested topic unless they are testing mismatch.
const TOPIC = "0.0.10590142";
// The payer recorded on the mirrored testnet message used in the fixtures.
const PAYER = "0.0.10585648";

// Both mirror hosts are compile-time constants now, so an SSRF rejection can
// only be simulated: the guard mock rejects for URLs carrying this marker
// topic id. Real behavior (assertUrlIsPublic inspecting the host) is covered
// by the safe-fetch suite; what is tested here is the step's handling.
const SSRF_TOPIC = "0.0.777777";

function withTopicEcho(body: Record<string, unknown>): Record<string, unknown> {
  return { topic_id: TOPIC, ...body };
}

describe("hedera plugin — verify-message", () => {
  beforeEach(() => {
    safeFetchMock.mockReset();
    vi.mocked(assertUrlIsPublic).mockReset().mockResolvedValue(undefined);
  });

  it("rejects an invalid topic id", async () => {
    const { verifyMessageStep } = await import(
      "@/plugins/hedera/steps/verify-message"
    );
    const result = await verifyMessageStep({
      topicId: "not-a-topic",
      sequenceNumber: "1",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/topic/i);
    }
    expect(safeFetchMock).not.toHaveBeenCalled();
  });

  it("rejects a non-integer sequence number", async () => {
    const { verifyMessageStep } = await import(
      "@/plugins/hedera/steps/verify-message"
    );
    const result = await verifyMessageStep({
      topicId: TOPIC,
      sequenceNumber: "abc",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/sequence/i);
    }
    expect(safeFetchMock).not.toHaveBeenCalled();
  });

  it("decodes a base64 message and verifies a matching expected payload", async () => {
    safeFetchMock.mockResolvedValue(
      mirrorOk(
        withTopicEcho({
          message: b64('{"type":"RELEASED","sessionId":"psn_1"}'),
          consensus_timestamp: "1726000000.123456789",
          sequence_number: 18,
          payer_account_id: PAYER,
        })
      )
    );
    const { verifyMessageStep } = await import(
      "@/plugins/hedera/steps/verify-message"
    );
    const result = await verifyMessageStep({
      topicId: TOPIC,
      sequenceNumber: "18",
      expectedMessage: '{"type":"RELEASED","sessionId":"psn_1"}',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.found).toBe(true);
      expect(result.verified).toBe(true);
      expect(result.message).toBe('{"type":"RELEASED","sessionId":"psn_1"}');
      expect(result.consensusTimestamp).toBe("1726000000.123456789");
      expect(result.payerAccountId).toBe(PAYER);
    }
  });

  it("reports verified=false when the payload does not match", async () => {
    safeFetchMock.mockResolvedValue(
      mirrorOk(
        withTopicEcho({
          message: b64("different"),
          consensus_timestamp: "1726000000.1",
          sequence_number: 18,
        })
      )
    );
    const { verifyMessageStep } = await import(
      "@/plugins/hedera/steps/verify-message"
    );
    const result = await verifyMessageStep({
      topicId: TOPIC,
      sequenceNumber: "18",
      expectedMessage: "expected",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.found).toBe(true);
      expect(result.verified).toBe(false);
    }
  });

  it("trims both the expected message and the decoded payload before comparing", async () => {
    safeFetchMock.mockResolvedValue(
      mirrorOk(
        withTopicEcho({
          message: b64('{"type":"RELEASED"}\n'),
          consensus_timestamp: "1726000000.3",
          sequence_number: 18,
        })
      )
    );
    const { verifyMessageStep } = await import(
      "@/plugins/hedera/steps/verify-message"
    );
    const result = await verifyMessageStep({
      topicId: TOPIC,
      sequenceNumber: "18",
      expectedMessage: '  {"type":"RELEASED"}  ',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.found).toBe(true);
      expect(result.verified).toBe(true);
    }
  });

  it("counts an anchored empty message as found", async () => {
    safeFetchMock.mockResolvedValue(
      mirrorOk(
        withTopicEcho({
          message: b64(""),
          consensus_timestamp: "1726000000.2",
          sequence_number: 19,
        })
      )
    );
    const { verifyMessageStep } = await import(
      "@/plugins/hedera/steps/verify-message"
    );
    const result = await verifyMessageStep({
      topicId: TOPIC,
      sequenceNumber: "19",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.found).toBe(true);
      expect(result.verified).toBe(false);
      expect(result.message).toBe("");
    }
  });

  it("exposes payerAccountId even without an expected submitter", async () => {
    safeFetchMock.mockResolvedValue(
      mirrorOk(
        withTopicEcho({
          message: b64("payload"),
          consensus_timestamp: "1.0",
          sequence_number: 18,
          payer_account_id: PAYER,
        })
      )
    );
    const { verifyMessageStep } = await import(
      "@/plugins/hedera/steps/verify-message"
    );
    const result = await verifyMessageStep({
      topicId: TOPIC,
      sequenceNumber: "18",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.payerAccountId).toBe(PAYER);
      // No expected submitter configured: content check only.
      expect(result.verified).toBe(false);
    }
  });

  it("reports verified=false when the submitter does not match the expected account", async () => {
    safeFetchMock.mockResolvedValue(
      mirrorOk(
        withTopicEcho({
          message: b64("release"),
          consensus_timestamp: "1.0",
          sequence_number: 18,
          payer_account_id: PAYER,
        })
      )
    );
    const { verifyMessageStep } = await import(
      "@/plugins/hedera/steps/verify-message"
    );
    const result = await verifyMessageStep({
      topicId: TOPIC,
      sequenceNumber: "18",
      expectedMessage: "release",
      expectedSubmitter: "0.0.11111111",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.found).toBe(true);
      // Right bytes, wrong writer: verified must not flip true.
      expect(result.verified).toBe(false);
      expect(result.payerAccountId).toBe(PAYER);
    }
  });

  it("reports verified=true when the expected submitter matches the payer", async () => {
    safeFetchMock.mockResolvedValue(
      mirrorOk(
        withTopicEcho({
          message: b64("release"),
          consensus_timestamp: "1.0",
          sequence_number: 18,
          payer_account_id: PAYER,
        })
      )
    );
    const { verifyMessageStep } = await import(
      "@/plugins/hedera/steps/verify-message"
    );
    const result = await verifyMessageStep({
      topicId: TOPIC,
      sequenceNumber: "18",
      expectedMessage: "release",
      expectedSubmitter: PAYER,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.verified).toBe(true);
    }
  });

  it("accepts a zero-padded expected submitter against the mirror's normalised payer", async () => {
    safeFetchMock.mockResolvedValue(
      mirrorOk(
        withTopicEcho({
          message: b64("release"),
          consensus_timestamp: "1.0",
          sequence_number: 18,
          payer_account_id: PAYER,
        })
      )
    );
    const { verifyMessageStep } = await import(
      "@/plugins/hedera/steps/verify-message"
    );
    const result = await verifyMessageStep({
      topicId: TOPIC,
      sequenceNumber: "18",
      expectedMessage: "release",
      expectedSubmitter: "0.0.010585648",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.verified).toBe(true);
    }
  });

  it("rejects a malformed expected submitter before any request", async () => {
    const { verifyMessageStep } = await import(
      "@/plugins/hedera/steps/verify-message"
    );
    const result = await verifyMessageStep({
      topicId: TOPIC,
      sequenceNumber: "18",
      expectedSubmitter: "0.0.abc",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/expected submitter/i);
      expect(result.errorClass).toBeDefined();
    }
    expect(safeFetchMock).not.toHaveBeenCalled();
  });

  it("rejects a mirror answer describing a different topic or sequence", async () => {
    safeFetchMock.mockResolvedValue(
      mirrorOk({
        // Attacker/host answering a valid-looking body for the wrong target:
        topic_id: "0.0.999",
        message: b64("expected"),
        consensus_timestamp: "1.0",
        sequence_number: 18,
      })
    );
    const { verifyMessageStep } = await import(
      "@/plugins/hedera/steps/verify-message"
    );
    const result = await verifyMessageStep({
      topicId: TOPIC,
      sequenceNumber: "18",
      expectedMessage: "expected",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/describes topic/i);
      expect(result.errorClass).toBeDefined();
    }
  });

  it("rejects a mirror answer whose sequence does not match the request", async () => {
    safeFetchMock.mockResolvedValue(
      mirrorOk(
        withTopicEcho({
          message: b64("x"),
          consensus_timestamp: "1.0",
          sequence_number: 7,
        })
      )
    );
    const { verifyMessageStep } = await import(
      "@/plugins/hedera/steps/verify-message"
    );
    const result = await verifyMessageStep({
      topicId: TOPIC,
      sequenceNumber: "18",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/sequence "18"/);
    }
  });

  it("fails with a USER error when the message is chunked", async () => {
    safeFetchMock.mockResolvedValue(
      mirrorOk(
        withTopicEcho({
          message: b64("first-fragment"),
          consensus_timestamp: "1.0",
          sequence_number: 18,
          chunk_info: { total: 3 },
        })
      )
    );
    const { verifyMessageStep } = await import(
      "@/plugins/hedera/steps/verify-message"
    );
    const result = await verifyMessageStep({
      topicId: TOPIC,
      sequenceNumber: "18",
      expectedMessage: "first-fragment",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/chunked/i);
    }
  });

  it("treats a 404 on an existing topic as found=false with success=true", async () => {
    safeFetchMock.mockImplementation(async (url: string | URL) => {
      if (String(url).endsWith(`/topics/${encodeURIComponent(TOPIC)}`)) {
        return { ok: true, status: 200, text: async () => "{}" };
      }
      return mirror404();
    });
    const { verifyMessageStep } = await import(
      "@/plugins/hedera/steps/verify-message"
    );
    const result = await verifyMessageStep({
      topicId: TOPIC,
      sequenceNumber: "999",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.found).toBe(false);
      expect(result.verified).toBe(false);
      expect(result.message).toBeNull();
    }
    expect(safeFetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns a USER error on 404 when the topic itself does not exist", async () => {
    safeFetchMock.mockResolvedValue(mirror404());
    const { verifyMessageStep } = await import(
      "@/plugins/hedera/steps/verify-message"
    );
    const result = await verifyMessageStep({
      topicId: "0.0.99999999",
      sequenceNumber: "18",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/does not exist/i);
      expect(result.errorClass).toBeDefined();
    }
  });

  it("reports a 429 on the message query as an EXTERNAL mirror failure", async () => {
    safeFetchMock.mockResolvedValue({
      ok: false,
      status: 429,
      text: async () => "rate limited",
    });
    const { verifyMessageStep } = await import(
      "@/plugins/hedera/steps/verify-message"
    );
    const result = await verifyMessageStep({
      topicId: TOPIC,
      sequenceNumber: "18",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/429/);
      expect(result.errorClass).toBeDefined();
    }
  });

  it("reports a 5xx on the message query as an EXTERNAL mirror failure", async () => {
    safeFetchMock.mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => "unavailable",
    });
    const { verifyMessageStep } = await import(
      "@/plugins/hedera/steps/verify-message"
    );
    const result = await verifyMessageStep({
      topicId: TOPIC,
      sequenceNumber: "18",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/503/);
    }
  });

  it("reports a non-404 4xx (bad 19-digit topic id) as a USER configuration error", async () => {
    safeFetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      text: async () =>
        JSON.stringify({
          _status: { messages: [{ message: "Invalid parameter: topic.id" }] },
        }),
    });
    const { verifyMessageStep } = await import(
      "@/plugins/hedera/steps/verify-message"
    );
    const result = await verifyMessageStep({
      topicId: "0.0.9999999999999999999",
      sequenceNumber: "18",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/rejected the request/i);
      expect(result.errorClass).toBeDefined();
    }
  });

  it("surfaces an SSRF rejection on the main query as a USER error without fetching", async () => {
    vi.mocked(assertUrlIsPublic).mockImplementation(async (url) => {
      if (String(url).includes(SSRF_TOPIC)) {
        throw new SsrfBlockedError({
          hostname: SSRF_TOPIC,
          reason: "private-range" as never,
          message: "blocked by guard",
        });
      }
    });
    const { verifyMessageStep } = await import(
      "@/plugins/hedera/steps/verify-message"
    );
    const result = await verifyMessageStep({
      topicId: SSRF_TOPIC,
      sequenceNumber: "18",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/not allowed/i);
      expect(result.errorClass).toBeDefined();
    }
    expect(safeFetchMock).not.toHaveBeenCalled();
  });

  it("re-throws an SSRF rejection raised by the topic probe instead of reading it as topic-exists", async () => {
    // Main query 404s, so the probe runs; the guard rejects the probe URL
    // (which, unlike the message URL, has no /messages/ segment) and that
    // rejection must escape rather than be swallowed as "topic exists".
    vi.mocked(assertUrlIsPublic).mockImplementation(async (url) => {
      if (String(url).endsWith(`/topics/${encodeURIComponent(SSRF_TOPIC)}`)) {
        throw new SsrfBlockedError({
          hostname: SSRF_TOPIC,
          reason: "private-range" as never,
          message: "blocked by guard",
        });
      }
    });
    safeFetchMock.mockResolvedValue(mirror404());
    const { verifyMessageStep } = await import(
      "@/plugins/hedera/steps/verify-message"
    );
    await expect(
      verifyMessageStep({ topicId: SSRF_TOPIC, sequenceNumber: "18" })
    ).rejects.toThrow(/blocked/);
  });

  it("fails with an EXTERNAL error when the probe cannot confirm the topic (network failure)", async () => {
    safeFetchMock.mockImplementation(async (url: string | URL) => {
      if (String(url).endsWith(`/topics/${encodeURIComponent(TOPIC)}`)) {
        throw new Error("getaddrinfo ENOTFOUND");
      }
      return mirror404();
    });
    const { verifyMessageStep } = await import(
      "@/plugins/hedera/steps/verify-message"
    );
    const result = await verifyMessageStep({
      topicId: TOPIC,
      sequenceNumber: "999",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/could not confirm/i);
      expect(result.errorClass).toBeDefined();
    }
  });

  it("fails with an EXTERNAL error when the probe answers with a server fault", async () => {
    safeFetchMock.mockImplementation(async (url: string | URL) => {
      if (String(url).endsWith(`/topics/${encodeURIComponent(TOPIC)}`)) {
        return { ok: false, status: 503, text: async () => "unavailable" };
      }
      return mirror404();
    });
    const { verifyMessageStep } = await import(
      "@/plugins/hedera/steps/verify-message"
    );
    const result = await verifyMessageStep({
      topicId: TOPIC,
      sequenceNumber: "999",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/could not confirm/i);
      expect(result.errorClass).toBeDefined();
    }
  });

  it("passes the plugin attribution and a real abort signal to safeFetch", async () => {
    safeFetchMock.mockResolvedValue(
      mirrorOk(
        withTopicEcho({
          message: b64("x"),
          consensus_timestamp: "1.0",
          sequence_number: 18,
        })
      )
    );
    const { verifyMessageStep } = await import(
      "@/plugins/hedera/steps/verify-message"
    );
    const result = await verifyMessageStep({
      topicId: TOPIC,
      sequenceNumber: "18",
    });
    expect(result.success).toBe(true);
    expect(safeFetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = safeFetchMock.mock.calls[0];
    expect(String(url)).toContain(
      "testnet.mirrornode.hedera.com/api/v1/topics/0.0.10590142/messages/18"
    );
    expect(init.plugin).toBe("hedera");
    // The step builds the signal with AbortSignal.timeout(30_000); the delay
    // itself is not introspectable on the signal, so assert the type here and
    // exercise the timeout's catch path in the probe-failure cases above.
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("network selects which mirror host is queried", async () => {
    safeFetchMock.mockResolvedValue(
      mirrorOk({
        topic_id: TOPIC,
        message: b64("x"),
        consensus_timestamp: "1.0",
        sequence_number: 18,
      })
    );
    const { verifyMessageStep } = await import(
      "@/plugins/hedera/steps/verify-message"
    );
    const result = await verifyMessageStep({
      topicId: TOPIC,
      sequenceNumber: "18",
      network: "mainnet",
    });
    expect(result.success).toBe(true);
    const [url] = safeFetchMock.mock.calls[0];
    expect(String(url)).toContain("mainnet.mirrornode.hedera.com");
  });

  it("binds a zero-padded topic id and sequence to the mirror's normalised echo", async () => {
    safeFetchMock.mockResolvedValue(
      mirrorOk({
        topic_id: "0.0.10590142",
        message: b64("expected"),
        consensus_timestamp: "1.0",
        sequence_number: 1,
      })
    );
    const { verifyMessageStep } = await import(
      "@/plugins/hedera/steps/verify-message"
    );
    const result = await verifyMessageStep({
      topicId: "0.0.010590142",
      sequenceNumber: "01",
      expectedMessage: "expected",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.found).toBe(true);
      expect(result.verified).toBe(true);
      expect(result.sequenceNumber).toBe("1");
    }
  });

  it("rejects an unknown network", async () => {
    const { verifyMessageStep } = await import(
      "@/plugins/hedera/steps/verify-message"
    );
    const result = await verifyMessageStep({
      topicId: TOPIC,
      sequenceNumber: "18",
      network: "testnest",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/network/i);
    }
    expect(safeFetchMock).not.toHaveBeenCalled();
  });

  it("stays credential-free: no connection fields and no credential requirement", async () => {
    // The verify path reads no credentials, so the integration must not ask for
    // any. ActionConfigFieldBase has no envVar, so the earlier version of this
    // case could never fire; the registry-wide invariant it was reaching for
    // lives in tests/unit/credential-map-coverage.test.ts (every credentials.X
    // read in a step file must map to a PLUGIN_CREDENTIAL_MAP envVar). What is
    // checkable here is the plugin-level surface, and that is what a failure
    // would actually change.
    const plugin = (await import("@/plugins/hedera/index")).default;
    expect(plugin.requiresCredentials).toBe(false);
    expect(plugin.formFields).toHaveLength(0);
    expect(plugin.actions.length).toBeGreaterThan(0);
    // The new expectedSubmitter field rides on the action config, not on the
    // connection: the plugin still declares no formFields.
    const firstAction = plugin.actions[0] as unknown as {
      configFields: { key: string }[];
      outputFields: { field: string }[];
    };
    expect(
      firstAction.configFields.some((f) => f.key === "expectedSubmitter")
    ).toBe(true);
    expect(
      firstAction.outputFields.some((f) => f.field === "payerAccountId")
    ).toBe(true);
    // The docs/config surface must not publish the live topic used during
    // development: placeholder and example use a reserved-looking example id.
    const topicField = firstAction.configFields.find(
      (f): f is { key: string; placeholder?: string; example?: string } =>
        f.key === "topicId"
    );
    expect(topicField?.placeholder).toBe("0.0.99999999");
    expect(topicField?.example).toBe("0.0.99999999");
  });
});
