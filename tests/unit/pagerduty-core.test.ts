import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { safeFetch } = vi.hoisted(() => ({ safeFetch: vi.fn() }));
vi.mock("@/lib/safe-fetch", () => ({
  safeFetch,
  SsrfBlockedError: class SsrfBlockedError extends Error {},
}));

import {
  cacheSizesForTest,
  clearOAuthTokenCache,
  clearRoutingKeyCache,
  createIncident,
  findIncidentByKey,
  listServices,
  postEvent,
  postEventWithRetries,
  resolveAuthHeader,
  resolveRoutingKey,
  subdomainFromHtmlUrl,
} from "@/plugins/pagerduty/steps/pagerduty-core";

const TOKEN_CREDS = { PAGERDUTY_API_TOKEN: "u+token" };
const OAUTH_CREDS = {
  PAGERDUTY_OAUTH_CLIENT_ID: "client",
  PAGERDUTY_OAUTH_CLIENT_SECRET: "secret",
  PAGERDUTY_SUBDOMAIN: "acme",
};

function response(
  status: number,
  body: unknown = {},
  headers: Record<string, string> = {}
) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (key: string) => headers[key.toLowerCase()] ?? null },
    json: () => Promise.resolve(body),
  };
}

function lastCall(index = 0): [string, Record<string, unknown>] {
  return safeFetch.mock.calls[index] as [string, Record<string, unknown>];
}

beforeEach(() => {
  safeFetch.mockReset();
  clearOAuthTokenCache();
  clearRoutingKeyCache();
});

describe("resolveAuthHeader", () => {
  it("uses the API token directly, with no round trip", async () => {
    const result = await resolveAuthHeader(TOKEN_CREDS);
    expect(result).toEqual({ ok: true, value: "Token token=u+token" });
    expect(safeFetch).not.toHaveBeenCalled();
  });

  it("exchanges OAuth client credentials and caches the bearer token", async () => {
    safeFetch.mockResolvedValue(
      response(200, { access_token: "abc", expires_in: 3600 })
    );

    const first = await resolveAuthHeader(OAUTH_CREDS);
    const second = await resolveAuthHeader(OAUTH_CREDS);

    expect(first).toEqual({ ok: true, value: "Bearer abc" });
    expect(second).toEqual({ ok: true, value: "Bearer abc" });
    expect(safeFetch).toHaveBeenCalledTimes(1);

    const [url, init] = lastCall();
    expect(url).toBe("https://identity.pagerduty.com/oauth/token");
    expect(String(init.body)).toContain("grant_type=client_credentials");
    expect(String(init.body)).toContain("as_account-us.acme");
  });

  it("scopes the OAuth request to the EU account when the region is set", async () => {
    safeFetch.mockResolvedValue(
      response(200, { access_token: "abc", expires_in: 3600 })
    );
    await resolveAuthHeader({ ...OAUTH_CREDS, PAGERDUTY_EU_REGION: "true" });
    expect(String(lastCall()[1].body)).toContain("as_account-eu.acme");
  });

  it("explains a rejected OAuth app rather than echoing the status", async () => {
    safeFetch.mockResolvedValue(response(401, {}));
    const result = await resolveAuthHeader(OAUTH_CREDS);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.message).toContain("rejected the OAuth client");
      expect(result.failure.retryable).toBe(false);
    }
  });

  /**
   * The runtime hands back an empty credential set for a deleted connection
   * and for one whose creator was deactivated, not only for an unfilled form,
   * so the message has to name all three causes.
   */
  it("names every reason there are no credentials, not just an empty form", async () => {
    const result = await resolveAuthHeader({});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.message).toContain("removed");
      expect(result.failure.message).toContain("deactivated");
      expect(result.failure.message).toContain("REST API token");
      expect(result.failure.retryable).toBe(false);
    }
  });
});

describe("listServices", () => {
  it("maps the account's services, including whether they can take events", async () => {
    safeFetch.mockResolvedValue(
      response(200, {
        services: [
          {
            id: "PSVC1",
            name: "Keeper Bots",
            html_url: "https://acme.pagerduty.com/service-directory/PSVC1",
            escalation_policy: { id: "PEP1", summary: "Platform On-Call" },
            integrations: [
              { id: "PI1", type: "events_api_v2_inbound_integration" },
            ],
          },
          {
            id: "PSVC2",
            name: "Email only",
            integrations: [
              { id: "PI2", type: "generic_email_inbound_integration" },
            ],
          },
        ],
      })
    );

    const result = await listServices(TOKEN_CREDS);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.truncated).toBe(false);
      expect(result.value.services[0]).toMatchObject({
        id: "PSVC1",
        name: "Keeper Bots",
        escalationPolicyName: "Platform On-Call",
        acceptsEvents: true,
      });
      expect(result.value.services[1].acceptsEvents).toBe(false);
    }
    expect(lastCall()[0]).toContain("https://api.pagerduty.com/services");
  });

  it("talks to the EU host for an EU account", async () => {
    safeFetch.mockResolvedValue(response(200, { services: [] }));
    await listServices({ ...TOKEN_CREDS, PAGERDUTY_EU_REGION: "true" });
    expect(lastCall()[0]).toContain("https://api.eu.pagerduty.com/");
  });

  it("names the missing read access on a 403 instead of saying 'failed'", async () => {
    safeFetch.mockResolvedValue(response(403, {}));
    const result = await listServices(TOKEN_CREDS);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.message).toContain("services.read");
      expect(result.failure.retryable).toBe(false);
    }
  });

  it("calls out a lapsed PagerDuty subscription on a 402", async () => {
    safeFetch.mockResolvedValue(response(402, {}));
    const result = await listServices(TOKEN_CREDS);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.message).toContain("subscription");
      expect(result.failure.retryable).toBe(false);
    }
  });

  it("points at connection rotation on a 401", async () => {
    safeFetch.mockResolvedValue(response(401, {}));
    const result = await listServices(TOKEN_CREDS);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.message).toContain("Settings");
    }
  });

  it("re-exchanges an OAuth token after a 401 instead of reusing the cached one", async () => {
    safeFetch
      .mockResolvedValueOnce(
        response(200, { access_token: "a", expires_in: 3600 })
      )
      .mockResolvedValueOnce(response(401, {}))
      .mockResolvedValueOnce(
        response(200, { access_token: "b", expires_in: 3600 })
      )
      .mockResolvedValueOnce(response(200, { services: [] }));

    await listServices(OAUTH_CREDS);
    const second = await listServices(OAUTH_CREDS);

    expect(second.ok).toBe(true);
    expect(safeFetch).toHaveBeenCalledTimes(4);
  });
});

/**
 * The flag arrives as a string from the connection checkbox, from an
 * environment variable on a self-hosted install, and from an MCP caller. Only
 * the checkbox is guaranteed to write "true", and reading the rest as US
 * points every request at the wrong regional host - which comes back as a 401
 * and reads as a bad token.
 */
/**
 * A client-credentials grant is refused outright if it asks for a scope the
 * app does not hold. Asking for a fixed superset and falling back to the
 * minimal pair loses every combination in between - including the one the
 * connection form recommends, two read scopes plus incidents.read.
 */
describe("OAuth scope requests", () => {
  function tokenThenOk() {
    safeFetch
      .mockResolvedValueOnce(
        response(200, { access_token: "tok", expires_in: 3600 })
      )
      .mockResolvedValueOnce(response(200, { incidents: [] }));
  }

  it("asks only for the scopes the call needs", async () => {
    tokenThenOk();
    await findIncidentByKey(OAUTH_CREDS, {
      serviceId: "PSVC1",
      incidentKey: "k1",
    });
    const scope = new URLSearchParams(
      String((safeFetch.mock.calls[0] as [string, { body: string }])[1].body)
    ).get("scope");
    expect(scope).toBe(
      "as_account-us.acme services.read escalation_policies.read incidents.read"
    );
  });

  it("does not repeat a scope the pair already covers", async () => {
    safeFetch
      .mockResolvedValueOnce(
        response(200, { access_token: "tok", expires_in: 3600 })
      )
      .mockResolvedValueOnce(response(200, { services: [] }));
    await listServices(OAUTH_CREDS);
    const scope = new URLSearchParams(
      String((safeFetch.mock.calls[0] as [string, { body: string }])[1].body)
    ).get("scope");
    expect(scope).toBe(
      "as_account-us.acme services.read escalation_policies.read"
    );
  });

  it("holds a separate token per scope set rather than reusing one", async () => {
    tokenThenOk();
    await findIncidentByKey(OAUTH_CREDS, {
      serviceId: "PSVC1",
      incidentKey: "k1",
    });
    safeFetch
      .mockResolvedValueOnce(
        response(200, { access_token: "tok2", expires_in: 3600 })
      )
      .mockResolvedValueOnce(response(200, { services: [] }));
    await listServices(OAUTH_CREDS);
    // Second exchange, because the first token was issued for a scope set
    // this call does not need - not a cache miss on the credential.
    expect(safeFetch.mock.calls[2][0]).toContain("identity.pagerduty.com");
  });

  it("falls back to the pair when the app does not hold the extra scope", async () => {
    safeFetch
      .mockResolvedValueOnce(response(400, { error: "invalid_scope" }))
      .mockResolvedValueOnce(
        response(200, { access_token: "tok", expires_in: 3600 })
      )
      .mockResolvedValueOnce(response(200, { incidents: [] }));
    const result = await findIncidentByKey(OAUTH_CREDS, {
      serviceId: "PSVC1",
      incidentKey: "k1",
    });
    expect(result.ok).toBe(true);
    const retried = new URLSearchParams(
      String((safeFetch.mock.calls[1] as [string, { body: string }])[1].body)
    ).get("scope");
    expect(retried).toBe(
      "as_account-us.acme services.read escalation_policies.read"
    );
  });
});

/**
 * Both caches are keyed by the credential, so a rotation mints keys the old
 * entries can never be reached by again, and the routing key cache adds a
 * dimension per service. `expiresAt` only decides whether an entry may be
 * used - on its own it evicts nothing, so a worker that stays up for weeks
 * and serves every organisation grew these maps forever.
 */
describe("the in-process caches do not grow without bound", () => {
  it("drops an expired entry rather than carrying it", async () => {
    safeFetch.mockResolvedValue(
      response(200, {
        service: {
          integrations: [
            { id: "PI1", type: "events_api_v2_inbound_integration" },
          ],
        },
      })
    );
    safeFetch.mockResolvedValue(
      response(200, { integration: { integration_key: "R1" } })
    );

    const now = Date.now();
    const clock = vi.spyOn(Date, "now");
    try {
      clock.mockReturnValue(now);
      safeFetch
        .mockResolvedValueOnce(
          response(200, {
            service: {
              integrations: [
                { id: "PI1", type: "events_api_v2_inbound_integration" },
              ],
            },
          })
        )
        .mockResolvedValueOnce(
          response(200, { integration: { integration_key: "R1" } })
        );
      await resolveRoutingKey(TOKEN_CREDS, "PSVC1");
      expect(cacheSizesForTest().routingKeys).toBe(1);

      // Past the five-minute TTL, writing any other entry sweeps the dead one.
      clock.mockReturnValue(now + 6 * 60 * 1000);
      safeFetch
        .mockResolvedValueOnce(
          response(200, {
            service: {
              integrations: [
                { id: "PI2", type: "events_api_v2_inbound_integration" },
              ],
            },
          })
        )
        .mockResolvedValueOnce(
          response(200, { integration: { integration_key: "R2" } })
        );
      await resolveRoutingKey(TOKEN_CREDS, "PSVC2");
      expect(cacheSizesForTest().routingKeys).toBe(1);
    } finally {
      clock.mockRestore();
    }
  });

  it("keeps an entry that is still live", async () => {
    for (const [service, key] of [
      ["PSVC1", "R1"],
      ["PSVC2", "R2"],
    ]) {
      safeFetch
        .mockResolvedValueOnce(
          response(200, {
            service: {
              integrations: [
                { id: "PI1", type: "events_api_v2_inbound_integration" },
              ],
            },
          })
        )
        .mockResolvedValueOnce(
          response(200, { integration: { integration_key: key } })
        );
      await resolveRoutingKey(TOKEN_CREDS, service);
    }
    expect(cacheSizesForTest().routingKeys).toBe(2);
  });
});

describe("service region flag", () => {
  it.each(["true", "TRUE", " 1 ", "yes", "eu", "on"])(
    "reads %s as the EU region",
    async (flag) => {
      safeFetch.mockResolvedValue(response(200, { services: [] }));
      await listServices({ ...TOKEN_CREDS, PAGERDUTY_EU_REGION: flag });
      expect(lastCall()[0]).toContain("https://api.eu.pagerduty.com/");
    }
  );

  it.each(["false", "", "0", "no", "us"])(
    "reads %s as the US region",
    async (flag) => {
      safeFetch.mockResolvedValue(response(200, { services: [] }));
      await listServices({ ...TOKEN_CREDS, PAGERDUTY_EU_REGION: flag });
      expect(lastCall()[0]).toContain("https://api.pagerduty.com/");
    }
  );
});

describe("resolveRoutingKey", () => {
  it("pages through a large account instead of stopping at the first 100", async () => {
    safeFetch
      .mockResolvedValueOnce(
        response(200, {
          services: [{ id: "PA", name: "A", integrations: [] }],
          more: true,
        })
      )
      .mockResolvedValueOnce(
        response(200, {
          services: [{ id: "PB", name: "B", integrations: [] }],
          more: false,
        })
      );

    const result = await listServices(TOKEN_CREDS);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.services.map((service) => service.id)).toEqual([
        "PA",
        "PB",
      ]);
      expect(result.value.truncated).toBe(false);
    }
    expect(String(safeFetch.mock.calls[1][0])).toContain("offset=100");
  });

  it("reads the key from the service's Events API v2 integration", async () => {
    safeFetch
      .mockResolvedValueOnce(
        response(200, {
          service: {
            id: "PSVC1",
            integrations: [
              { id: "PI9", type: "events_api_v2_inbound_integration" },
            ],
          },
        })
      )
      .mockResolvedValueOnce(
        response(200, { integration: { integration_key: "R123" } })
      );

    const result = await resolveRoutingKey(TOKEN_CREDS, "PSVC1");
    expect(result).toEqual({
      ok: true,
      value: { routingKey: "R123", serviceStatus: undefined },
    });
  });

  it("says the service is gone on a 404, and does not ask for a retry", async () => {
    safeFetch.mockResolvedValue(response(404, {}));
    const result = await resolveRoutingKey(TOKEN_CREDS, "PGONE");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.message).toContain("PGONE");
      expect(result.failure.message).toContain("no longer exists");
      expect(result.failure.retryable).toBe(false);
    }
  });

  it("explains a service with no Events integration", async () => {
    safeFetch.mockResolvedValue(
      response(200, {
        service: {
          id: "PSVC2",
          integrations: [
            { id: "PI2", type: "generic_email_inbound_integration" },
          ],
        },
      })
    );
    const result = await resolveRoutingKey(TOKEN_CREDS, "PSVC2");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.message).toContain("no Events API v2 integration");
    }
  });

  it("does not invent a key when PagerDuty withholds it", async () => {
    safeFetch
      .mockResolvedValueOnce(
        response(200, {
          service: {
            integrations: [
              { id: "PI9", type: "events_api_v2_inbound_integration" },
            ],
          },
        })
      )
      .mockResolvedValueOnce(response(200, { integration: {} }));

    const result = await resolveRoutingKey(TOKEN_CREDS, "PSVC1");
    expect(result.ok).toBe(false);
  });
});

describe("postEvent", () => {
  it("posts to the events host and returns the dedup key PagerDuty settled on", async () => {
    safeFetch.mockResolvedValue(
      response(202, {
        status: "success",
        message: "Event processed",
        dedup_key: "k1",
      })
    );
    const result = await postEvent(TOKEN_CREDS, { routing_key: "R1" } as never);
    expect(result).toEqual({
      ok: true,
      value: { dedupKey: "k1", message: "Event processed" },
    });
    expect(lastCall()[0]).toBe("https://events.pagerduty.com/v2/enqueue");
  });

  it("quotes PagerDuty's own errors on a 400 and refuses to retry it", async () => {
    safeFetch.mockResolvedValue(
      response(400, {
        status: "invalid event",
        message: "Event object is invalid",
        errors: ["Invalid routing key"],
      })
    );
    const result = await postEvent(TOKEN_CREDS, {} as never);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.message).toContain("Invalid routing key");
      expect(result.failure.retryable).toBe(false);
    }
  });

  it("treats a rate limit as retryable and keeps PagerDuty's own wait", async () => {
    safeFetch.mockResolvedValue(response(429, {}, { "retry-after": "3" }));
    const result = await postEvent(TOKEN_CREDS, {} as never);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.retryable).toBe(true);
      expect(result.failure.retryAfterMs).toBe(3000);
    }
  });
});

describe("postEventWithRetries", () => {
  it("retries a 500 and reports the eventual success", async () => {
    safeFetch
      .mockResolvedValueOnce(response(500, {}))
      .mockResolvedValueOnce(response(202, { dedup_key: "k1" }));
    const wait = vi.fn().mockResolvedValue(undefined);

    const result = await postEventWithRetries({
      credentials: TOKEN_CREDS,
      body: {} as never,
      maxRetries: 2,
      baseDelayMs: 1000,
      wait,
    });

    expect(result.ok).toBe(true);
    expect(safeFetch).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledWith(1000);
  });

  it("never retries a rejected payload", async () => {
    safeFetch.mockResolvedValue(response(400, { message: "bad" }));
    const wait = vi.fn().mockResolvedValue(undefined);

    await postEventWithRetries({
      credentials: TOKEN_CREDS,
      body: {} as never,
      maxRetries: 3,
      baseDelayMs: 1000,
      wait,
    });

    expect(safeFetch).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
  });

  it("retries a dropped connection, because a duplicate event merges", async () => {
    safeFetch
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(response(202, { dedup_key: "k1" }));
    const wait = vi.fn().mockResolvedValue(undefined);

    const result = await postEventWithRetries({
      credentials: TOKEN_CREDS,
      body: {} as never,
      maxRetries: 2,
      baseDelayMs: 500,
      wait,
    });

    expect(result.ok).toBe(true);
    expect(safeFetch).toHaveBeenCalledTimes(2);
  });

  it("says the event was not confirmed when the network fails outright", async () => {
    safeFetch.mockRejectedValue(new TypeError("fetch failed"));
    const result = await postEventWithRetries({
      credentials: TOKEN_CREDS,
      body: {} as never,
      maxRetries: 1,
      baseDelayMs: 0,
      wait: vi.fn().mockResolvedValue(undefined),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.message).toContain("not confirmed");
    }
  });

  it("honours the wait PagerDuty asks for on a rate limit", async () => {
    safeFetch
      .mockResolvedValueOnce(response(429, {}, { "retry-after": "5" }))
      .mockResolvedValueOnce(response(202, {}));
    const wait = vi.fn().mockResolvedValue(undefined);

    await postEventWithRetries({
      credentials: TOKEN_CREDS,
      body: {} as never,
      maxRetries: 1,
      baseDelayMs: 1000,
      wait,
    });

    expect(wait).toHaveBeenCalledWith(5000);
  });
});

describe("findIncidentByKey", () => {
  it("reports the incident's status", async () => {
    safeFetch.mockResolvedValue(
      response(200, {
        incidents: [{ id: "PINC1", status: "resolved", html_url: "https://x" }],
      })
    );
    const result = await findIncidentByKey(TOKEN_CREDS, {
      serviceId: "PSVC1",
      incidentKey: "k1",
    });
    expect(result).toEqual({
      ok: true,
      value: { status: "resolved", id: "PINC1", htmlUrl: "https://x" },
    });
  });

  it("answers unknown rather than 'absent' when PagerDuty returns nothing", async () => {
    safeFetch.mockResolvedValue(response(200, { incidents: [] }));
    const result = await findIncidentByKey(TOKEN_CREDS, {
      serviceId: "PSVC1",
      incidentKey: "k1",
    });
    expect(result).toEqual({ ok: true, value: { status: "unknown" } });
  });
});

describe("createIncident", () => {
  it("sends the From header PagerDuty requires and returns the incident", async () => {
    safeFetch.mockResolvedValue(
      response(201, {
        incident: {
          id: "PINC1",
          incident_number: 42,
          html_url: "https://acme.pagerduty.com/incidents/PINC1",
          status: "triggered",
        },
      })
    );

    const result = await createIncident(TOKEN_CREDS, {
      serviceId: "PSVC1",
      title: "Keeper stalled",
      fromEmail: "ops@acme.io",
    });

    expect(result.ok).toBe(true);
    const [url, init] = lastCall();
    expect(url).toBe("https://api.pagerduty.com/incidents");
    expect((init.headers as Record<string, string>).From).toBe("ops@acme.io");
  });

  it("carries the escalation policy override when one is given", async () => {
    safeFetch.mockResolvedValue(response(201, { incident: { id: "PINC1" } }));
    await createIncident(TOKEN_CREDS, {
      serviceId: "PSVC1",
      title: "t",
      fromEmail: "ops@acme.io",
      escalationPolicyId: "PEP9",
    });
    const body = JSON.parse(String(lastCall()[1].body));
    expect(body.incident.escalation_policy).toEqual({
      id: "PEP9",
      type: "escalation_policy_reference",
    });
  });
});

describe("subdomainFromHtmlUrl", () => {
  it("reads the account from a US url", () => {
    expect(
      subdomainFromHtmlUrl("https://acme.pagerduty.com/service-directory/P1")
    ).toBe("acme");
  });

  it("reads the account from an EU url", () => {
    expect(
      subdomainFromHtmlUrl("https://acme.eu.pagerduty.com/incidents/P1")
    ).toBe("acme");
  });

  it("ignores anything that is not a PagerDuty url", () => {
    expect(subdomainFromHtmlUrl("https://example.com/x")).toBeUndefined();
    expect(subdomainFromHtmlUrl(undefined)).toBeUndefined();
    expect(subdomainFromHtmlUrl("not a url")).toBeUndefined();
  });
});
