import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// vi.hoisted ensures the spy exists before the mock factory runs — the
// factory is invoked when safe-fetch.ts imports @sentry/nextjs during ES
// module graph resolution, which is before top-level test file statements
// execute. A bare `const` would hit TDZ.
const { captureException, mockPromisesLookup } = vi.hoisted(() => ({
  captureException: vi.fn(),
  mockPromisesLookup: vi.fn(),
}));
vi.mock("@sentry/nextjs", () => ({
  captureException,
}));

// Override only `promises.lookup` (used by `assertUrlIsPublic`). The
// callback-form `lookup` from the same module is preserved so the undici
// connector inside `safeFetch` continues to use real DNS for the
// `safeFetch` tests below — those tests rely on `localhost` resolving to
// 127.0.0.1 / ::1.
vi.mock("node:dns", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:dns")>();
  return {
    ...actual,
    promises: {
      ...actual.promises,
      lookup: mockPromisesLookup,
    },
  };
});

const incrementCounter = vi.fn();
vi.mock("@/lib/metrics", () => ({
  getMetricsCollector: () => ({
    incrementCounter,
    recordLatency: vi.fn(),
    recordError: vi.fn(),
    setGauge: vi.fn(),
  }),
}));

import {
  assertUrlIsPublic,
  isBlockedHost,
  isBlockedIp,
  isShadowMode,
  SsrfBlockedError,
  type SsrfBlockReason,
  safeFetch,
} from "@/lib/safe-fetch";

const LABELSET_ERROR_RE = /initial labelset/i;

describe("isBlockedIp", () => {
  const blockedV4: [string, SsrfBlockReason][] = [
    ["0.0.0.0", "private-ip"],
    ["10.1.2.3", "private-ip"],
    ["100.64.0.1", "private-ip"],
    ["127.0.0.1", "loopback"],
    ["127.255.255.254", "loopback"],
    ["169.254.169.254", "link-local"],
    ["172.16.0.1", "private-ip"],
    ["172.31.255.254", "private-ip"],
    ["192.168.0.1", "private-ip"],
    ["192.168.255.254", "private-ip"],
    ["198.18.0.1", "private-ip"],
    ["224.0.0.1", "multicast"],
    ["239.255.255.255", "multicast"],
    ["240.0.0.1", "reserved"],
    ["255.255.255.255", "reserved"],
  ];

  for (const [ip, reason] of blockedV4) {
    it(`blocks IPv4 ${ip} (${reason})`, () => {
      const result = isBlockedIp(ip);
      expect(result.blocked).toBe(true);
      if (result.blocked) {
        expect(result.reason).toBe(reason);
      }
    });
  }

  const blockedV6: [string, SsrfBlockReason][] = [
    ["::", "private-ip"],
    ["::1", "loopback"],
    ["fe80::1", "link-local"],
    ["fc00::1", "private-ip"],
    ["fd00::1", "private-ip"],
    ["ff02::1", "multicast"],
    // Site-local NAT64 (RFC 8215). Distinct from the well-known 64:ff9b::/96
    // prefix, which is intentionally allowed when embedded IPv4 is public.
    ["64:ff9b:1::1", "private-ip"],
    ["64:ff9b:1:abcd::1", "private-ip"],
    // Teredo tunneling (2001::/32). Deprecated transition mechanism.
    ["2001::1", "private-ip"],
    ["2001:0:abcd:ef01:1234:5678:9abc:def0", "private-ip"],
    // 6to4 (2002::/16). Deprecated transition mechanism.
    ["2002::1", "private-ip"],
    ["2002:0102:0304::1", "private-ip"],
    // Documentation (2001:db8::/32). No legitimate traffic.
    ["2001:db8::1", "private-ip"],
    ["2001:db8:abcd::1", "private-ip"],
  ];

  for (const [ip, reason] of blockedV6) {
    it(`blocks IPv6 ${ip} (${reason})`, () => {
      const result = isBlockedIp(ip);
      expect(result.blocked).toBe(true);
      if (result.blocked) {
        expect(result.reason).toBe(reason);
      }
    });
  }

  it("blocks IPv4-mapped-IPv6 dotted form (::ffff:169.254.169.254)", () => {
    const result = isBlockedIp("::ffff:169.254.169.254");
    expect(result.blocked).toBe(true);
    if (result.blocked) {
      expect(result.reason).toBe("ipv4-mapped-private");
    }
  });

  it("blocks IPv4-mapped-IPv6 hex form (::ffff:a9fe:a9fe)", () => {
    const result = isBlockedIp("::ffff:a9fe:a9fe");
    expect(result.blocked).toBe(true);
  });

  // NAT64 (RFC 6052, 64:ff9b::/96): dual-stack pods synthesise these for
  // every IPv4-only public host. The wrapper is allowed; the embedded
  // IPv4 is what we check.
  it("allows NAT64-wrapped public IPv4 (64:ff9b::a29f:8ae8 -> 162.159.138.232 discord/cloudflare)", () => {
    const result = isBlockedIp("64:ff9b::a29f:8ae8");
    expect(result.blocked).toBe(false);
  });

  it("allows NAT64-wrapped public IPv4 dotted form (64:ff9b::1.1.1.1)", () => {
    const result = isBlockedIp("64:ff9b::1.1.1.1");
    expect(result.blocked).toBe(false);
  });

  it("blocks NAT64-wrapped link-local IPv4 (IMDS via NAT64)", () => {
    const result = isBlockedIp("64:ff9b::a9fe:a9fe");
    expect(result.blocked).toBe(true);
    if (result.blocked) {
      expect(result.reason).toBe("ipv4-nat64-private");
    }
  });

  it("blocks NAT64-wrapped RFC 1918 IPv4 (64:ff9b::0a00:0001 -> 10.0.0.1)", () => {
    const result = isBlockedIp("64:ff9b::a00:1");
    expect(result.blocked).toBe(true);
    if (result.blocked) {
      expect(result.reason).toBe("ipv4-nat64-private");
    }
  });

  it("blocks NAT64-wrapped loopback IPv4 dotted form (64:ff9b::127.0.0.1)", () => {
    const result = isBlockedIp("64:ff9b::127.0.0.1");
    expect(result.blocked).toBe(true);
    if (result.blocked) {
      expect(result.reason).toBe("ipv4-nat64-private");
    }
  });

  // Uncompressed form. c-ares normalises to canonical, so this branch is
  // mainly defensive — but the regex exists, so it should be exercised.
  it("allows NAT64-wrapped public IPv4 uncompressed form (64:ff9b:0:0:0:0:a29f:8ae8)", () => {
    const result = isBlockedIp("64:ff9b:0:0:0:0:a29f:8ae8");
    expect(result.blocked).toBe(false);
  });

  it("blocks NAT64-wrapped IMDS uncompressed form (64:ff9b:0:0:0:0:a9fe:a9fe)", () => {
    const result = isBlockedIp("64:ff9b:0:0:0:0:a9fe:a9fe");
    expect(result.blocked).toBe(true);
    if (result.blocked) {
      expect(result.reason).toBe("ipv4-nat64-private");
    }
  });

  const allowedV4 = ["8.8.8.8", "1.1.1.1", "93.184.216.34", "185.60.216.35"];
  for (const ip of allowedV4) {
    it(`allows public IPv4 ${ip}`, () => {
      const result = isBlockedIp(ip);
      expect(result.blocked).toBe(false);
    });
  }

  const allowedV6 = ["2001:4860:4860::8888", "2606:4700:4700::1111"];
  for (const ip of allowedV6) {
    it(`allows public IPv6 ${ip}`, () => {
      const result = isBlockedIp(ip);
      expect(result.blocked).toBe(false);
    });
  }

  it("returns not-blocked for non-IP strings", () => {
    expect(isBlockedIp("example.com").blocked).toBe(false);
    expect(isBlockedIp("").blocked).toBe(false);
    expect(isBlockedIp("not-an-ip").blocked).toBe(false);
  });
});

describe("isBlockedHost", () => {
  const blockedHosts = [
    "localhost",
    "LOCALHOST",
    "localhost.",
    "  localhost  ",
    "foo.local",
    "raspberrypi.local",
    "service.internal",
    "ip-10-0-0-5.us-east-2.compute.internal",
    "ip-172-31-1-1.ec2.internal",
    "instance-data.ec2.internal",
    "keeperhub-common.keeperhub.svc.cluster.local",
    "mypod.keeperhub.pod.cluster.local",
  ];

  for (const host of blockedHosts) {
    it(`blocks "${host}"`, () => {
      const result = isBlockedHost(host);
      expect(result.blocked).toBe(true);
      if (result.blocked) {
        expect(result.reason).toBe("blocked-host");
      }
    });
  }

  const allowedHosts = [
    "example.com",
    "www.example.com",
    "db.us-east-1.rds.amazonaws.com",
    "discord.com",
    "keeperhub.com",
    "myinternal.com",
    "mylocal.com",
    // IP literals are out of scope for the hostname check - isBlockedIp
    // catches them. isBlockedHost must not match them on the suffix rules.
    "127.0.0.1",
    "10.0.0.1",
    "::1",
    "fe80::1",
  ];

  for (const host of allowedHosts) {
    it(`allows "${host}"`, () => {
      expect(isBlockedHost(host).blocked).toBe(false);
    });
  }

  it("returns not-blocked for empty input", () => {
    expect(isBlockedHost("").blocked).toBe(false);
    expect(isBlockedHost("   ").blocked).toBe(false);
    expect(isBlockedHost(".").blocked).toBe(false);
  });
});

describe("isShadowMode", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is fail-closed (enforces) when SAFE_FETCH_SHADOW is unset", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("SAFE_FETCH_SHADOW", undefined);
    expect(isShadowMode()).toBe(false);
  });

  it("enters shadow mode on the explicit opt-in SAFE_FETCH_SHADOW='true' outside prod", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("SAFE_FETCH_SHADOW", "true");
    expect(isShadowMode()).toBe(true);
  });

  it("enforces for any non-'true' value (e.g. '1', 'false')", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("SAFE_FETCH_SHADOW", "1");
    expect(isShadowMode()).toBe(false);
    vi.stubEnv("SAFE_FETCH_SHADOW", "false");
    expect(isShadowMode()).toBe(false);
  });

  it("hard-enforces in real production (NODE_ENV=production, no CI) even with SAFE_FETCH_SHADOW='true'", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("CI", undefined);
    vi.stubEnv("SAFE_FETCH_SHADOW", "true");
    expect(isShadowMode()).toBe(false);
  });

  it("honors the opt-in under CI even when NODE_ENV=production (localhost-anvil e2e suites)", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("CI", "true");
    vi.stubEnv("SAFE_FETCH_SHADOW", "true");
    expect(isShadowMode()).toBe(true);
  });
});

describe("safeFetch (enforce mode)", () => {
  beforeEach(() => {
    // Unset opt-in => default enforce (fail-closed).
    vi.stubEnv("SAFE_FETCH_SHADOW", undefined);
    incrementCounter.mockClear();
    captureException.mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const blockedSchemes = [
    "file:///etc/passwd",
    "data:text/plain,hello",
    "gopher://example.com/",
    "ftp://example.com/",
  ];

  for (const url of blockedSchemes) {
    it(`rejects scheme in ${url}`, async () => {
      await expect(safeFetch(url)).rejects.toBeInstanceOf(SsrfBlockedError);
      expect(incrementCounter).toHaveBeenCalledWith(
        "safe_fetch.blocks.total",
        expect.objectContaining({ reason: "scheme", shadow: "false" })
      );
    });
  }

  const blockedLiteralUrls = [
    ["http://127.0.0.1/", "loopback"],
    ["http://169.254.169.254/latest/meta-data/", "link-local"],
    ["http://10.0.0.1/", "private-ip"],
    ["http://192.168.1.1/", "private-ip"],
    ["http://[::1]/", "loopback"],
    ["http://[fe80::1]/", "link-local"],
    ["http://[fc00::1]/", "private-ip"],
    ["http://[::ffff:169.254.169.254]/", "ipv4-mapped-private"],
    ["http://[64:ff9b::a9fe:a9fe]/", "ipv4-nat64-private"],
    ["http://[64:ff9b::a00:1]/", "ipv4-nat64-private"],
  ];

  for (const [url, reason] of blockedLiteralUrls) {
    it(`rejects IP literal ${url} (${reason})`, async () => {
      await expect(safeFetch(url as string)).rejects.toBeInstanceOf(
        SsrfBlockedError
      );
      expect(incrementCounter).toHaveBeenCalledWith(
        "safe_fetch.blocks.total",
        expect.objectContaining({ reason, shadow: "false" })
      );
    });
  }

  it("labels plugin when provided", async () => {
    await expect(
      safeFetch("http://127.0.0.1/", { plugin: "code" })
    ).rejects.toBeInstanceOf(SsrfBlockedError);
    expect(incrementCounter).toHaveBeenCalledWith(
      "safe_fetch.blocks.total",
      expect.objectContaining({ plugin_name: "code" })
    );
  });

  it("attributes plugin on hostname-pattern block (localhost)", async () => {
    // `localhost` is caught by the pre-DNS hostname denylist (isBlockedHost)
    // before any resolver runs, so the block is recorded synchronously with
    // the directly-passed plugin label. The previous DNS-resolved-attribution
    // path through AsyncLocalStorage is still present in the connector but
    // is no longer reachable via `localhost`; covering it would require
    // mocking the undici connector or using a non-pattern-matching
    // hostname that resolves to a private IP.
    await expect(
      safeFetch("http://localhost:9999/", { plugin: "webhook" })
    ).rejects.toThrow();
    expect(incrementCounter).toHaveBeenCalledWith(
      "safe_fetch.blocks.total",
      expect.objectContaining({
        plugin_name: "webhook",
        reason: "blocked-host",
      })
    );
  });

  const blockedHostnames = [
    "http://localhost/",
    "http://localhost:9999/",
    "http://foo.local/",
    "http://service.internal/",
    "http://ip-10-0-0-5.us-east-2.compute.internal/",
    "http://keeperhub-common.keeperhub.svc.cluster.local/",
    "http://mypod.keeperhub.pod.cluster.local/",
  ];

  for (const url of blockedHostnames) {
    it(`rejects hostname-pattern ${url}`, async () => {
      await expect(safeFetch(url)).rejects.toBeInstanceOf(SsrfBlockedError);
      expect(incrementCounter).toHaveBeenCalledWith(
        "safe_fetch.blocks.total",
        expect.objectContaining({ reason: "blocked-host", shadow: "false" })
      );
    });
  }

  it("throws TypeError for malformed URLs", async () => {
    await expect(safeFetch("not a url")).rejects.toBeInstanceOf(TypeError);
  });
});

describe("safeFetch (shadow mode)", () => {
  beforeEach(() => {
    // Shadow mode is opt-in via SAFE_FETCH_SHADOW="true" (honored everywhere
    // except real production; the test runner is not real prod). Leaving it
    // unset would enforce (fail-closed) and throw SsrfBlockedError, which
    // these tests do not expect.
    vi.stubEnv("SAFE_FETCH_SHADOW", "true");
    incrementCounter.mockClear();
    captureException.mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("records a block with shadow=true but does not throw SsrfBlockedError on IP literal", async () => {
    // The fetch itself will still fail to connect to 127.0.0.1 in the test
    // env (no listener). The important behaviour is that safe-fetch does
    // not short-circuit with SsrfBlockedError. Port 9999 avoids the
    // WHATWG fetch "bad port" list.
    try {
      await safeFetch("http://127.0.0.1:9999/");
    } catch (err) {
      expect(err).not.toBeInstanceOf(SsrfBlockedError);
    }
    const blockCalls = incrementCounter.mock.calls.filter(
      (call) => call[0] === "safe_fetch.blocks.total"
    );
    // Exactly one block per request, even though the connector's
    // post-DNS check would otherwise re-fire on the resolved IP. See
    // SafeFetchStore.initialBlockRecorded in safe-fetch.ts.
    expect(blockCalls).toHaveLength(1);
    expect(blockCalls[0]?.[1]).toMatchObject({
      reason: "loopback",
      shadow: "true",
    });
    expect(captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        level: "warning",
        tags: expect.objectContaining({
          safe_fetch_reason: "loopback",
          safe_fetch_shadow: "true",
        }),
      })
    );
  });

  it("records exactly one block in shadow mode for a hostname-pattern URL", async () => {
    // Regression: a single shadow-mode request to `http://localhost/` used
    // to be counted twice - once for the pre-DNS isBlockedHost match
    // (reason="blocked-host"), then again inside the connector's DNS
    // callback after `localhost` resolved to 127.0.0.1 (reason="loopback").
    // The fix threads `initialBlockRecorded` through pluginContext so the
    // connector skips its recordBlock when the entry-point check already
    // counted this request. The connect itself still happens, preserving
    // shadow-mode "log and continue" semantics.
    try {
      await safeFetch("http://localhost:9999/", { plugin: "webhook" });
    } catch (err) {
      expect(err).not.toBeInstanceOf(SsrfBlockedError);
    }
    const blockCalls = incrementCounter.mock.calls.filter(
      (call) => call[0] === "safe_fetch.blocks.total"
    );
    expect(blockCalls).toHaveLength(1);
    expect(blockCalls[0]?.[1]).toMatchObject({
      reason: "blocked-host",
      plugin_name: "webhook",
      shadow: "true",
    });
  });

  it("records scheme block with shadow=true on non-http URL", async () => {
    // undici will reject the scheme anyway; we just want to see the metric.
    await safeFetch("file:///etc/passwd").catch(() => undefined);
    expect(incrementCounter).toHaveBeenCalledWith(
      "safe_fetch.blocks.total",
      expect.objectContaining({ reason: "scheme", shadow: "true" })
    );
    expect(captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        level: "warning",
        tags: expect.objectContaining({
          safe_fetch_reason: "scheme",
          safe_fetch_shadow: "true",
        }),
      })
    );
  });

  it("does not throw a Prometheus labelset error from recordBlock (regression)", async () => {
    // Regression for KEEP-314: recordBlock originally routed the block log
    // through logUserError, which forwarded caller-supplied labels
    // (hostname, resolved_ip, shadow_mode) to a Prometheus error metric
    // with a fixed initial labelset. prom-client then threw "Added label
    // not included in initial labelset" from inside the fetch pipeline,
    // making shadow mode fatal for any workflow that hit a blocked IP.
    //
    // Uses loopback rather than link-local to avoid network-layer flake
    // (connect timeouts on 169.254.x.x vary by runner). recordBlock runs
    // synchronously before any network call, so the bug reproduces
    // regardless of which reason the block carries.
    let thrown: unknown;
    try {
      await safeFetch("http://127.0.0.1:9999/", { plugin: "code" });
    } catch (err) {
      thrown = err;
    }
    if (thrown !== undefined) {
      const message = thrown instanceof Error ? thrown.message : String(thrown);
      expect(message).not.toMatch(LABELSET_ERROR_RE);
    }
    expect(captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        level: "warning",
        tags: expect.objectContaining({
          safe_fetch_reason: "loopback",
          safe_fetch_shadow: "true",
          plugin_name: "code",
        }),
      })
    );
  });
});

describe("assertUrlIsPublic", () => {
  beforeEach(() => {
    mockPromisesLookup.mockReset();
  });

  it("rejects malformed URLs with TypeError", async () => {
    await expect(assertUrlIsPublic("not a url")).rejects.toBeInstanceOf(
      TypeError
    );
  });

  it("rejects empty hostname with TypeError", async () => {
    // `file:///etc/passwd` parses but the hostname is empty.
    // Scheme check fires first, so this also exercises that path.
    await expect(
      assertUrlIsPublic("file:///etc/passwd")
    ).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  const blockedSchemes = [
    "file:///etc/passwd",
    "data:text/plain,hello",
    "gopher://example.com/",
    "ftp://example.com/",
    "javascript:alert(1)",
  ];

  for (const url of blockedSchemes) {
    it(`rejects scheme in ${url}`, async () => {
      await expect(assertUrlIsPublic(url)).rejects.toBeInstanceOf(
        SsrfBlockedError
      );
      try {
        await assertUrlIsPublic(url);
      } catch (err) {
        expect((err as SsrfBlockedError).reason).toBe("scheme");
      }
    });
  }

  const blockedLiterals: [string, SsrfBlockReason][] = [
    ["http://127.0.0.1/", "loopback"],
    ["http://169.254.169.254/latest/meta-data/", "link-local"],
    ["http://10.0.0.1/", "private-ip"],
    ["http://192.168.1.1/", "private-ip"],
    ["http://172.16.0.1/", "private-ip"],
    ["https://[::1]/", "loopback"],
    ["https://[fe80::1]/", "link-local"],
    ["https://[fc00::1]/", "private-ip"],
    ["http://[::ffff:169.254.169.254]/", "ipv4-mapped-private"],
    ["http://[64:ff9b::a9fe:a9fe]/", "ipv4-nat64-private"],
  ];

  for (const [url, reason] of blockedLiterals) {
    it(`rejects IP-literal ${url} (${reason})`, async () => {
      let thrown: unknown;
      try {
        await assertUrlIsPublic(url);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(SsrfBlockedError);
      expect((thrown as SsrfBlockedError).reason).toBe(reason);
      // No DNS lookup for IP literals.
      expect(mockPromisesLookup).not.toHaveBeenCalled();
    });
  }

  const allowedLiterals = [
    "http://1.1.1.1/",
    "https://8.8.8.8/",
    "https://[2606:4700:4700::1111]/",
    // NAT64-wrapped public IPv4 (discord.com via Cloudflare). Dual-stack
    // pods see this for IPv4-only hosts; the embedded IPv4 is public, so
    // the wrapper is allowed.
    "https://[64:ff9b::a29f:8ae8]/",
  ];

  for (const url of allowedLiterals) {
    it(`accepts public IP literal ${url}`, async () => {
      await expect(assertUrlIsPublic(url)).resolves.toBeUndefined();
      expect(mockPromisesLookup).not.toHaveBeenCalled();
    });
  }

  it("accepts a domain that resolves only to public addresses", async () => {
    mockPromisesLookup.mockResolvedValue([{ address: "1.1.1.1", family: 4 }]);
    await expect(
      assertUrlIsPublic("https://rpc.example.com/")
    ).resolves.toBeUndefined();
    expect(mockPromisesLookup).toHaveBeenCalledWith(
      "rpc.example.com",
      expect.objectContaining({ all: true })
    );
  });

  it("rejects a domain that resolves to a private IPv4", async () => {
    mockPromisesLookup.mockResolvedValue([{ address: "10.0.0.5", family: 4 }]);
    let thrown: unknown;
    try {
      await assertUrlIsPublic("https://internal.example.com/");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(SsrfBlockedError);
    expect((thrown as SsrfBlockedError).reason).toBe("private-ip");
    expect((thrown as SsrfBlockedError).resolvedIp).toBe("10.0.0.5");
  });

  it("rejects a domain that resolves to IMDS (link-local)", async () => {
    mockPromisesLookup.mockResolvedValue([
      { address: "169.254.169.254", family: 4 },
    ]);
    let thrown: unknown;
    try {
      await assertUrlIsPublic("https://metadata.example.com/");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(SsrfBlockedError);
    expect((thrown as SsrfBlockedError).reason).toBe("link-local");
  });

  it("rejects when ANY resolved address is private (mixed dual-stack)", async () => {
    // dual-stack split-horizon: first record public, second private.
    // Must reject — an attacker can race the second record.
    mockPromisesLookup.mockResolvedValue([
      { address: "1.1.1.1", family: 4 },
      { address: "10.0.0.5", family: 4 },
    ]);
    await expect(
      assertUrlIsPublic("https://split-horizon.example.com/")
    ).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it("rejects a domain that resolves to private IPv6 (ULA)", async () => {
    mockPromisesLookup.mockResolvedValue([{ address: "fc00::1", family: 6 }]);
    let thrown: unknown;
    try {
      await assertUrlIsPublic("https://ula.example.com/");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(SsrfBlockedError);
    expect((thrown as SsrfBlockedError).reason).toBe("private-ip");
  });

  it("accepts a domain that resolves to NAT64-wrapped public IPv4", async () => {
    // Dual-stack pod resolving discord.com gets a 64:ff9b::/96 AAAA
    // synthesised from 162.159.138.232 (public Cloudflare). Must allow.
    mockPromisesLookup.mockResolvedValue([
      { address: "64:ff9b::a29f:8ae8", family: 6 },
    ]);
    await expect(
      assertUrlIsPublic("https://discord.com/")
    ).resolves.toBeUndefined();
  });

  it("rejects a domain that resolves to NAT64-wrapped private IPv4", async () => {
    mockPromisesLookup.mockResolvedValue([
      { address: "64:ff9b::a00:1", family: 6 },
    ]);
    let thrown: unknown;
    try {
      await assertUrlIsPublic("https://nat64-private.example.com/");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(SsrfBlockedError);
    expect((thrown as SsrfBlockedError).reason).toBe("ipv4-nat64-private");
  });

  it("throws a plain Error when DNS resolution fails", async () => {
    mockPromisesLookup.mockRejectedValue(
      Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" })
    );
    let thrown: unknown;
    try {
      await assertUrlIsPublic("https://nonexistent.example.com/");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(SsrfBlockedError);
    expect(thrown).not.toBeInstanceOf(TypeError);
  });

  const blockedHostnames = [
    "http://localhost/",
    "http://foo.local/",
    "http://service.internal/",
    "http://ip-10-0-0-5.us-east-2.compute.internal/",
    "http://keeperhub-common.keeperhub.svc.cluster.local/",
    "http://mypod.keeperhub.pod.cluster.local/",
  ];

  for (const url of blockedHostnames) {
    it(`rejects hostname-pattern ${url} before any DNS lookup`, async () => {
      let thrown: unknown;
      try {
        await assertUrlIsPublic(url);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(SsrfBlockedError);
      expect((thrown as SsrfBlockedError).reason).toBe("blocked-host");
      expect(mockPromisesLookup).not.toHaveBeenCalled();
    });
  }
});
