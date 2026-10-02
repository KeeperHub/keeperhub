import { afterEach, describe, expect, it, vi } from "vitest";
import { testPredge } from "@/plugins/predge/test";

// plugins/predge/test.ts is reachable from the client-bundled plugin registry,
// so it has to load with nothing server-only stubbed. This file mocks only the
// fetch global.

const PINNED =
  "13fa3d18a369e6c71bf941563ba47822b30182273d5106a0e8fb61c5016352d9";
const OTHER =
  "a122cc095c0f7fe52645be73dd496498a2d10f7018e85db2f9d721f0a3d997e4";

function attestationKey(publicKey: string, active = true) {
  return {
    kid: publicKey.slice(0, 16),
    algorithm: "ed25519",
    public_key: publicKey,
    active,
    role: "attestation",
  };
}

function keyset(keys: Record<string, unknown>[]) {
  return { issuer: "predge.io", version: "predge-attest-v1", keys };
}

function respondWith(body: unknown, status = 200) {
  return vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(
      new Response(typeof body === "string" ? body : JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      })
    );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("testPredge", () => {
  it("passes when the keyset lists the pinned key as its active attestation key", async () => {
    const fetchSpy = respondWith(
      keyset([
        attestationKey(PINNED),
        { ...attestationKey(OTHER), role: "cachet-oracle" },
      ])
    );

    expect(await testPredge({})).toEqual({ success: true });

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.predge.io/.well-known/predge-keys.json");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("fails when the pinned key has been rotated out", async () => {
    // At cutover the replaced key stays listed with active: false, so a check
    // for "listed" alone would pass here.
    respondWith(keyset([attestationKey(OTHER), attestationKey(PINNED, false)]));

    const result = await testPredge({});
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/no longer the active attestation key/);
    expect(result.error).toMatch(/set Pinned Signer Key to the new published key/);
  });

  it("fails when the pinned key is not listed at all", async () => {
    respondWith(keyset([attestationKey(OTHER)]));

    const result = await testPredge({});
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/is not listed in the published keyset/);
  });

  it("does not accept the pinned key under another role", async () => {
    respondWith(keyset([{ ...attestationKey(PINNED), role: "cachet-oracle" }]));

    expect((await testPredge({})).success).toBe(false);
  });

  it("checks the operator's pinned key instead of the default when one is set", async () => {
    respondWith(keyset([attestationKey(OTHER)]));
    expect(
      await testPredge({ PREDGE_SIGNER_KEY_ID: ` ${OTHER.toUpperCase()} ` })
    ).toEqual({ success: true });

    vi.restoreAllMocks();
    respondWith(keyset([attestationKey(PINNED)]));
    const result = await testPredge({ PREDGE_SIGNER_KEY_ID: OTHER });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/^Your Pinned Signer Key is not listed/);
  });

  it("fails on a body that is not a keyset", async () => {
    for (const body of ["<html>proxy error</html>", {}, { keys: "none" }]) {
      vi.restoreAllMocks();
      respondWith(body);
      const result = await testPredge({});
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/did not return a Predge keyset/);
    }
  });

  it("reports a non-2xx status", async () => {
    respondWith("", 404);

    const result = await testPredge({});
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/HTTP 404/);
  });

  it("does not follow a redirect", async () => {
    // handlePluginTest checks the configured URL, not where a redirect points,
    // so following one would let a public URL steer the request inward.
    for (const status of [301, 302, 307, 308]) {
      vi.restoreAllMocks();
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(null, {
          status,
          headers: { location: "http://169.254.169.254/latest/meta-data/" },
        })
      );

      const result = await testPredge({
        PREDGE_SIGNAL_URL: "https://signals.example.com",
      });

      expect(result.success).toBe(false);
      expect(result.error).toMatch(
        new RegExp(`redirected \\(HTTP ${status}\\).*does not follow redirects`)
      );
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(init.redirect).toBe("manual");
    }
  });

  it("reads the keyset from the operator's signal URL", async () => {
    const fetchSpy = respondWith(keyset([attestationKey(PINNED)]));

    await testPredge({ PREDGE_SIGNAL_URL: " https://signals.example.com// " });

    const [url] = fetchSpy.mock.calls[0] as [string];
    expect(url).toBe("https://signals.example.com/.well-known/predge-keys.json");
  });
});
