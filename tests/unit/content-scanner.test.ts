import { afterEach, describe, expect, it, vi } from "vitest";
import { rawConsole } from "@/lib/log/core";

// logSecurityEvent writes the structured line via lib/log/core's rawConsole.
const raw = rawConsole as unknown as Record<
  "debug" | "info" | "warn" | "error",
  (line: string) => void
>;

const captureMessageMock = vi.fn();
vi.mock("@sentry/nextjs", () => ({
  captureMessage: (message: string, context: unknown): void => {
    captureMessageMock(message, context);
  },
}));

const { scanNodes, scanTriggerInput, scanAndReport } = await import(
  "@/lib/security/content-scanner"
);

afterEach(() => {
  captureMessageMock.mockReset();
});

type Hit = {
  pattern: string;
  nodeId: string;
  nodeType: string;
  jsonPath: string;
};

function node(
  id: string,
  config: unknown,
  type = "action"
): {
  id: string;
  data: { type: string; config: unknown };
} {
  return { id, data: { type, config } };
}

describe("scanNodes — pattern matches", () => {
  it("detects the IMDS metadata IP in a URL", () => {
    const hits = scanNodes([
      node("n1", { endpoint: "http://169.254.169.254/latest/meta-data/" }),
    ]);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      pattern: "imds_metadata_ip",
      nodeId: "n1",
      jsonPath: "n1.config.endpoint",
    });
  });

  it("detects information_schema (case-insensitive)", () => {
    const hits = scanNodes([
      node("n1", { query: "SELECT * FROM INFORMATION_SCHEMA.tables" }),
    ]);
    expect(hits.map((h: Hit) => h.pattern)).toContain("pg_information_schema");
  });

  it("detects pg_catalog (case-insensitive)", () => {
    const hits = scanNodes([
      node("n1", { query: "SELECT * FROM pg_catalog.pg_user" }),
    ]);
    expect(hits.map((h: Hit) => h.pattern)).toContain("pg_catalog");
  });

  it("detects neon_auth in nested object", () => {
    // Real-world shape: SQL touching Neon's auth schema. Underscores count
    // as word chars so the boundary fires on the `.` after `auth`, not
    // mid-token in something like `neon_authentication`.
    const hits = scanNodes([
      node("n1", { query: "SELECT * FROM neon_auth.users_sync" }),
    ]);
    expect(hits[0]).toMatchObject({
      pattern: "neon_auth",
      jsonPath: "n1.config.query",
    });
  });

  it("detects refresh_token in an array element", () => {
    const hits = scanNodes([
      node("n1", { body: ["client_id=abc", "grant_type=refresh_token"] }),
    ]);
    expect(hits.map((h: Hit) => h.pattern)).toContain("refresh_token");
    expect(hits[0].jsonPath).toBe("n1.config.body[1]");
  });

  it("detects client_secret", () => {
    const hits = scanNodes([node("n1", { body: "client_secret=topsecret" })]);
    expect(hits.map((h: Hit) => h.pattern)).toContain("client_secret");
  });

  it("detects DATABASE_URL (uppercase)", () => {
    const hits = scanNodes([node("n1", { template: "{{env.DATABASE_URL}}" })]);
    expect(hits.map((h: Hit) => h.pattern)).toContain("database_url");
  });

  it("detects lowercase database_url too (case-insensitive)", () => {
    // env templates routinely use {{env.database_url}}; the case-sensitive
    // form silently missed these.
    const hits = scanNodes([node("n1", { template: "{{env.database_url}}" })]);
    expect(hits.map((h: Hit) => h.pattern)).toContain("database_url");
  });
});

describe("scanNodes — non-matches and edge cases", () => {
  it("returns empty for benign config", () => {
    expect(
      scanNodes([
        node("n1", { name: "Send Discord message", channel: "#general" }),
      ])
    ).toEqual([]);
  });

  it("skips nodes with null/undefined config", () => {
    expect(scanNodes([node("n1", null), node("n2", undefined)])).toEqual([]);
  });

  it("does not match information_schema substring without word boundary", () => {
    const hits = scanNodes([node("n1", { name: "myinformation_schemaXXX" })]);
    expect(hits.map((h: Hit) => h.pattern)).not.toContain(
      "pg_information_schema"
    );
  });

  it("handles deeply nested structures", () => {
    const hits = scanNodes([
      node("n1", {
        request: {
          options: {
            params: ["safe", { secret: "client_secret=abc" }],
          },
        },
      }),
    ]);
    expect(hits).toHaveLength(1);
    expect(hits[0].jsonPath).toBe("n1.config.request.options.params[1].secret");
  });

  it("captures multiple distinct (node, pattern) hits across nodes", () => {
    const hits = scanNodes([
      node("n1", { endpoint: "http://169.254.169.254/" }),
      node("n2", { query: "SELECT * FROM pg_catalog.x" }),
    ]);
    expect(hits.map((h: Hit) => `${h.nodeId}:${h.pattern}`)).toEqual([
      "n1:imds_metadata_ip",
      "n2:pg_catalog",
    ]);
  });
});

describe("scanAndReport", () => {
  it("emits one Sentry event with deduped hits when matches exist", () => {
    scanAndReport(
      [
        node("n1", {
          a: "169.254.169.254",
          b: "169.254.169.254 also here",
        }),
      ],
      { workflowId: "wf_1", executionId: "exec_1", organizationId: "org_1" }
    );
    expect(captureMessageMock).toHaveBeenCalledTimes(1);
    const [message, options] = captureMessageMock.mock.calls[0] as [
      string,
      { extra: { hitCount: number; hits: Hit[] } },
    ];
    expect(message).toBe("security.content_scanner_hit");
    // Two textual matches in n1.config.* under same (nodeId, pattern) -> deduped to one
    expect(options.extra.hitCount).toBe(1);
    expect(options.extra.hits).toHaveLength(1);
    expect(options.extra.hits[0].pattern).toBe("imds_metadata_ip");
  });

  it("does not emit when there are no hits", () => {
    scanAndReport([node("n1", { name: "Send Discord" })], {
      workflowId: "wf_2",
    });
    expect(captureMessageMock).not.toHaveBeenCalled();
  });

  it("never includes the matched value in the Sentry payload", () => {
    scanAndReport(
      [node("n1", { secret: "client_secret=THIS_IS_THE_SECRET_VALUE" })],
      { workflowId: "wf_3" }
    );
    const payloadJson = JSON.stringify(captureMessageMock.mock.calls[0][1]);
    expect(payloadJson).not.toContain("THIS_IS_THE_SECRET_VALUE");
    expect(payloadJson).toContain("client_secret"); // pattern name only
  });

  it("swallows Sentry transport failure (best-effort capture)", () => {
    captureMessageMock.mockImplementationOnce(() => {
      throw new Error("sentry down");
    });
    expect(() =>
      scanAndReport([node("n1", { endpoint: "http://169.254.169.254/" })], {
        workflowId: "wf_4",
      })
    ).not.toThrow();
  });

  it("emits a structured error signal when the scan itself throws", () => {
    const warnSpy = vi.spyOn(raw, "warn").mockImplementation(() => {
      // swallow the line in test
    });
    // Force a throw inside the scan: reading `.nodes` blows up, simulating a
    // scanner bug. The probe must not throw into the executor AND must leave a
    // signal, so a silently-broken scanner is itself detectable rather than
    // dropping detection to zero.
    const exploding = {
      get nodes(): never {
        throw new Error("scanner exploded");
      },
    } as unknown as { nodes: never };
    expect(() =>
      scanAndReport(exploding, { workflowId: "wf_err" })
    ).not.toThrow();
    const errorLine = warnSpy.mock.calls
      .map((call) => String(call[0]))
      .find((line) => line.includes("security.content_scanner_error"));
    expect(errorLine).toBeDefined();
    expect(errorLine).toContain("wf_err");
    expect(errorLine).toContain("scanner exploded");
    warnSpy.mockRestore();
  });
});

describe("scanTriggerInput — runtime payload coverage", () => {
  it("returns empty for null/undefined input", () => {
    expect(scanTriggerInput(null)).toEqual([]);
    expect(scanTriggerInput(undefined)).toEqual([]);
  });

  it("returns empty for benign trigger input", () => {
    expect(scanTriggerInput({ user: "alice", action: "create_order" })).toEqual(
      []
    );
  });

  it("flags IMDS IPv4 in a string trigger input", () => {
    const hits = scanTriggerInput("ping http://169.254.169.254/latest/");
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      source: "trigger_input",
      pattern: "imds_metadata_ip",
      nodeId: "trigger_input",
      nodeType: "trigger",
      jsonPath: "trigger_input",
    });
  });

  it("flags information_schema injected via webhook body field", () => {
    const hits = scanTriggerInput({
      body: { q: "SELECT * FROM information_schema.tables" },
    });
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      source: "trigger_input",
      pattern: "pg_information_schema",
      jsonPath: "trigger_input.body.q",
    });
  });

  it("flags DATABASE_URL inside an array element", () => {
    const hits = scanTriggerInput({
      headers: ["x-debug: DATABASE_URL=postgres://..."],
    });
    expect(hits[0]).toMatchObject({
      source: "trigger_input",
      pattern: "database_url",
      jsonPath: "trigger_input.headers[0]",
    });
  });
});

describe("scanAndReport — combined config + trigger input", () => {
  it("reports hits from both config and trigger_input in one event", () => {
    scanAndReport(
      {
        nodes: [node("n1", { endpoint: "http://169.254.169.254/" })],
        triggerInput: { body: "client_secret=topsecret" },
      },
      { workflowId: "wf_combo" }
    );
    expect(captureMessageMock).toHaveBeenCalledTimes(1);
    const [, options] = captureMessageMock.mock.calls[0] as [
      string,
      {
        extra: {
          hitCount: number;
          hits: Array<{ source: string; pattern: string }>;
        };
      },
    ];
    expect(options.extra.hitCount).toBe(2);
    const tuples = options.extra.hits.map((h) => `${h.source}:${h.pattern}`);
    expect(tuples.sort()).toEqual([
      "config:imds_metadata_ip",
      "trigger_input:client_secret",
    ]);
  });

  it("keeps source as a dedupe key so same pattern in both surfaces emits two rows", () => {
    scanAndReport(
      {
        nodes: [node("n1", { url: "http://169.254.169.254/" })],
        triggerInput: { redirect: "http://169.254.169.254/admin" },
      },
      { workflowId: "wf_same_pattern_both" }
    );
    const [, options] = captureMessageMock.mock.calls[0] as [
      string,
      { extra: { hits: Array<{ source: string; pattern: string }> } },
    ];
    const sources = options.extra.hits
      .filter((h) => h.pattern === "imds_metadata_ip")
      .map((h) => h.source)
      .sort();
    expect(sources).toEqual(["config", "trigger_input"]);
  });

  it("accepts the legacy bare-nodes signature for backward compat", () => {
    // Existing callers (and the test above) pass a plain array of nodes.
    // New executor passes { nodes, triggerInput }. Both must work so this
    // refactor doesn't ripple beyond the executor.
    expect(() =>
      scanAndReport([node("n1", { name: "safe" })], { workflowId: "wf_legacy" })
    ).not.toThrow();
    expect(captureMessageMock).not.toHaveBeenCalled();
  });

  it("never includes matched values from trigger input either", () => {
    scanAndReport(
      {
        nodes: [],
        triggerInput: {
          secret: "client_secret=NEVER_LEAK_THIS_TOKEN_VIA_ALERT",
        },
      },
      { workflowId: "wf_no_leak_trigger" }
    );
    const payload = JSON.stringify(captureMessageMock.mock.calls[0][1]);
    expect(payload).not.toContain("NEVER_LEAK_THIS_TOKEN_VIA_ALERT");
    expect(payload).toContain("client_secret");
  });
});

describe("content scanner hardening (KEEP-612 follow-up)", () => {
  it("does not throw or stack-overflow on a deeply nested payload", () => {
    // Build a 5000-deep nested object -- the attacker-controlled webhook
    // shape that previously RangeError'd through scanValue into the executor.
    let deep: Record<string, unknown> = { leaf: "169.254.169.254" };
    for (let i = 0; i < 5000; i++) {
      deep = { nested: deep };
    }
    expect(() => scanTriggerInput(deep)).not.toThrow();
    // scanAndReport is the executor entry point -- must also be total.
    expect(() =>
      scanAndReport(
        { nodes: [], triggerInput: deep },
        { workflowId: "wf_deep" }
      )
    ).not.toThrow();
  });

  it("stops recursing past the depth cap (deep match is not reported)", () => {
    // A match buried far below MAX_SCAN_DEPTH (64) must not be found --
    // proves the cap actually bounds the walk rather than just catching throws.
    let deep: Record<string, unknown> = { leaf: "169.254.169.254" };
    for (let i = 0; i < 200; i++) {
      deep = { nested: deep };
    }
    const hits = scanTriggerInput(deep);
    expect(hits).toHaveLength(0);
  });

  it("finds a match that sits within the depth cap", () => {
    let shallow: Record<string, unknown> = { leaf: "169.254.169.254" };
    for (let i = 0; i < 10; i++) {
      shallow = { nested: shallow };
    }
    const hits = scanTriggerInput(shallow);
    expect(hits.map((h: Hit) => h.pattern)).toContain("imds_metadata_ip");
  });

  it("caps the hit count and appends a single scan_truncated marker", () => {
    // 5000 matching strings, all shallow (well under the depth cap), so the
    // hit cap -- not the depth cap -- is what bounds the result.
    const payload: Record<string, string> = {};
    for (let i = 0; i < 5000; i++) {
      payload[`k${i}`] = "169.254.169.254";
    }
    const hits = scanTriggerInput(payload);
    const markers = hits.filter((h: Hit) => h.pattern === "scan_truncated");
    expect(markers).toHaveLength(1);
    // Real hits are bounded at MAX_HITS (1000); +1 for the marker.
    expect(hits.length).toBeLessThanOrEqual(1001);
    expect(
      hits.filter((h: Hit) => h.pattern === "imds_metadata_ip").length
    ).toBeLessThanOrEqual(1000);
  });

  it("shares ONE hit budget across config + trigger input (no doubling)", () => {
    // Both sources individually saturate; scanAndReport must bound the
    // COMBINED payload to MAX_HITS, not 2x. Regression for the
    // concatenate-after-each-caps bug.
    const big: Record<string, string> = {};
    for (let i = 0; i < 5000; i++) {
      big[`k${i}`] = "169.254.169.254";
    }
    scanAndReport(
      { nodes: [node("n1", big)], triggerInput: big },
      { workflowId: "wf_combined_sat" }
    );
    const [, options] = captureMessageMock.mock.calls[0] as [
      string,
      { extra: { hitCount: number; hits: Hit[] } },
    ];
    // Combined real hits stay within MAX_HITS (+1 marker), not ~2x.
    expect(options.extra.hits.length).toBeLessThanOrEqual(1001);
  });
});
