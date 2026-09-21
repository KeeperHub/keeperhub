import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testPagerDuty } from "@/plugins/pagerduty/test";

const originalFetch = global.fetch;
const fetchMock = vi.fn();

function response(status: number, body: unknown = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

beforeEach(() => {
  fetchMock.mockReset();
  global.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  global.fetch = originalFetch;
});

describe("PagerDuty connection test", () => {
  /**
   * The steps bound every request they make; this file used to bound none, so
   * a host that accepted the connection and never answered held Test
   * Connection open with a spinner and nothing to tell it from a slow
   * account. The 401 path probes the other region, so it is two of these.
   */
  it("bounds every request it makes", async () => {
    fetchMock.mockResolvedValue(response(200, { services: [] }));
    await testPagerDuty({ PAGERDUTY_API_TOKEN: "t" });
    const init = fetchMock.mock.calls[0][1] as { signal?: AbortSignal };
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("bounds the OAuth exchange too", async () => {
    fetchMock
      .mockResolvedValueOnce(response(200, { access_token: "tok" }))
      .mockResolvedValueOnce(response(200, { services: [] }));
    await testPagerDuty({
      PAGERDUTY_OAUTH_CLIENT_ID: "id",
      PAGERDUTY_OAUTH_CLIENT_SECRET: "secret",
      PAGERDUTY_SUBDOMAIN: "acme",
    });
    for (const call of fetchMock.mock.calls) {
      const init = call[1] as { signal?: AbortSignal };
      expect(init.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it("checks the permission the plugin actually needs", async () => {
    fetchMock.mockResolvedValue(response(200, { services: [] }));
    const result = await testPagerDuty({ PAGERDUTY_API_TOKEN: "t" });
    expect(result).toEqual({ success: true });
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://api.pagerduty.com/services?limit=1"
    );
  });

  it("uses the EU host when the account is in the EU region", async () => {
    fetchMock.mockResolvedValue(response(200, {}));
    await testPagerDuty({
      PAGERDUTY_API_TOKEN: "t",
      PAGERDUTY_EU_REGION: "true",
    });
    expect(fetchMock.mock.calls[0][0]).toContain("api.eu.pagerduty.com");
  });

  /**
   * A self-hosted install sets this from an environment variable, where
   * nothing forces the exact string the checkbox writes. Reading anything but
   * "true" as US sends every event to the wrong region, and PagerDuty answers
   * 401 - which reads as a bad token.
   */
  it.each(["1", "yes", "TRUE", " eu "])(
    "reads %s as the EU region too",
    async (flag) => {
      fetchMock.mockResolvedValue(response(200, {}));
      await testPagerDuty({
        PAGERDUTY_API_TOKEN: "t",
        PAGERDUTY_EU_REGION: flag,
      });
      expect(fetchMock.mock.calls[0][0]).toContain("api.eu.pagerduty.com");
    }
  );

  /**
   * fetch throws on a header holding a line break, and the catch below would
   * report it as "could not reach PagerDuty" - sending someone to check their
   * network over a token they pasted with a trailing newline.
   */
  it("names a token pasted with a line break rather than blaming the network", async () => {
    const result = await testPagerDuty({ PAGERDUTY_API_TOKEN: "abc\ndef" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("line break");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  /**
   * The most confusing failure this connection has: a US account with the EU
   * box ticked answers 401, which reads as a bad token.
   */
  it("names the region when the credentials work in the other one", async () => {
    fetchMock
      .mockResolvedValueOnce(response(401))
      .mockResolvedValueOnce(response(200, {}));

    const result = await testPagerDuty({
      PAGERDUTY_API_TOKEN: "t",
      PAGERDUTY_EU_REGION: "true",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("US service region");
    expect(result.error).toContain("Untick");
  });

  it("names the other direction too", async () => {
    fetchMock
      .mockResolvedValueOnce(response(401))
      .mockResolvedValueOnce(response(200, {}));

    const result = await testPagerDuty({ PAGERDUTY_API_TOKEN: "t" });
    expect(result.error).toContain("EU service region");
    expect(result.error).toContain("Tick");
  });

  it("reports a genuinely bad token as a bad token", async () => {
    fetchMock.mockResolvedValue(response(401));
    const result = await testPagerDuty({ PAGERDUTY_API_TOKEN: "t" });
    expect(result.error).toContain("rejected the credentials");
  });

  it("explains a token that cannot read services", async () => {
    fetchMock.mockResolvedValue(response(403));
    const result = await testPagerDuty({ PAGERDUTY_API_TOKEN: "t" });
    expect(result.error).toContain("services.read");
  });

  it("blames the network, not the token, when PagerDuty cannot be reached", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    const result = await testPagerDuty({ PAGERDUTY_API_TOKEN: "t" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Could not reach PagerDuty");
    expect(result.error).toContain("were not checked");
  });

  it("asks for credentials when the form is empty", async () => {
    const result = await testPagerDuty({});
    expect(result.success).toBe(false);
    expect(result.error).toContain("REST API token");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("exchanges OAuth client credentials before checking access", async () => {
    fetchMock
      .mockResolvedValueOnce(response(200, { access_token: "abc" }))
      .mockResolvedValueOnce(response(200, {}));

    const result = await testPagerDuty({
      PAGERDUTY_OAUTH_CLIENT_ID: "client",
      PAGERDUTY_OAUTH_CLIENT_SECRET: "secret",
      PAGERDUTY_SUBDOMAIN: "acme",
    });

    expect(result).toEqual({ success: true });
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://identity.pagerduty.com/oauth/token"
    );
  });
});

/**
 * The EU checkbox's help text promises Test Connection will work out which
 * way it should be set. That held for API tokens only: a scoped OAuth app
 * carries the region inside its scope string, so the wrong one is rejected at
 * the token exchange, before the /services call the region probe hangs off.
 * An EU customer with a perfectly good app was told their client id and
 * secret were wrong.
 */
describe("region diagnosis on a scoped OAuth connection", () => {
  const oauthCredentials = {
    PAGERDUTY_OAUTH_CLIENT_ID: "PDABC12.oauth.pagerduty.com",
    PAGERDUTY_OAUTH_CLIENT_SECRET: "shh",
    PAGERDUTY_SUBDOMAIN: "acme",
  };

  it("names the region when the other one issues a token", async () => {
    // First exchange (US, as configured) is refused; the probe (EU) succeeds.
    fetchMock
      .mockResolvedValueOnce(response(400, {}))
      .mockResolvedValueOnce(response(200, { access_token: "tok" }));

    const result = await testPagerDuty(oauthCredentials);
    expect(result.success).toBe(false);
    expect(result.error).toContain("EU service region");
    expect(result.error).toContain("Tick");
  });

  it("still blames the credentials when neither region works", async () => {
    fetchMock
      .mockResolvedValueOnce(response(400, {}))
      .mockResolvedValueOnce(response(400, {}));

    const result = await testPagerDuty(oauthCredentials);
    expect(result.success).toBe(false);
    expect(result.error).toContain("client id");
    expect(result.error).not.toContain("EU service region");
  });
});

/**
 * One click, a bounded number of round trips.
 *
 * The 401 path probes the other region, and the OAuth path probes the other
 * region too. Left to themselves they call each other: the first probe finds
 * an OAuth rejection, probes back toward the region it started from, and a
 * single Test Connection click spends five sequential ten-second requests on
 * an answer it already had.
 */
describe("how many requests one Test Connection makes", () => {
  it("does not probe back from inside a probe", async () => {
    // OAuth only, and no API token: the token branch of resolveHeader returns
    // before `probing` is ever read, so a credential set carrying a token
    // exercises none of this.
    //
    // 1: token exchange succeeds. 2: /services answers 401, so the 401 path
    // probes the other region. 3: that region's token exchange is refused -
    // and must stop there rather than probing back to the first.
    fetchMock
      .mockResolvedValueOnce(response(200, { access_token: "tok" }))
      .mockResolvedValueOnce(response(401, {}))
      .mockResolvedValue(response(400, {}));

    await testPagerDuty({
      PAGERDUTY_OAUTH_CLIENT_ID: "PDABC12.oauth.pagerduty.com",
      PAGERDUTY_OAUTH_CLIENT_SECRET: "shh",
      PAGERDUTY_SUBDOMAIN: "acme",
    });

    expect(fetchMock.mock.calls.length).toBe(3);
    // And the identity endpoint really was reached, so this is the OAuth
    // path. Matched on the parsed hostname: a substring test would also pass
    // for a URL that merely carries the host in its path.
    const hosts = fetchMock.mock.calls.map(
      (call) => new URL(String(call[0])).hostname
    );
    expect(hosts).toContain("identity.pagerduty.com");
  });
});
