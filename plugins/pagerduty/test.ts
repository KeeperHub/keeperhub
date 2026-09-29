/**
 * Connection test for a PagerDuty credential.
 *
 * Reachable from the client-bundled plugin registry, so it cannot import the
 * server-only SSRF guard and uses the raw fetch global, like every other
 * plugin's test.ts. Both hosts it talks to are constants; the connection form
 * has no URL field for `handlePluginTest` to pre-flight.
 *
 * The check is GET /services?limit=1 rather than a generic ping, because that
 * is the exact permission every action needs: a token that cannot list
 * services cannot resolve a routing key, however valid it is.
 */
import {
  isEuRegionFlag,
  isHeaderSafeToken,
  PAGERDUTY_ACCEPT_V2,
  PAGERDUTY_API_HOST,
  PAGERDUTY_API_HOST_EU,
  PAGERDUTY_IDENTITY_TOKEN_URL,
  PAGERDUTY_OAUTH_SCOPES_MINIMAL,
  PAGERDUTY_REQUEST_TIMEOUT_MS,
  pagerDutyOAuthScope,
} from "./event-payload";

// The same pair the nodes ask for. Written out here a second time, this check
// would keep passing for a connection whose scopes the nodes had outgrown.
const OAUTH_SCOPES = PAGERDUTY_OAUTH_SCOPES_MINIMAL;

type TestResult = { success: boolean; error?: string };

async function resolveHeader(
  credentials: Record<string, string>,
  region: string,
  /**
   * True when this call is itself a region probe. It suppresses the probe
   * below, which would otherwise ask about the region we started from: the
   * 401 path already calls this for the other region, and that call finding
   * an OAuth rejection would probe back again, doubling the round trips on a
   * single Test Connection click for an answer already in hand.
   */
  probing = false
): Promise<{ header: string } | TestResult> {
  const token = credentials.PAGERDUTY_API_TOKEN?.trim();
  if (token) {
    // Without this, a token pasted with a line break makes fetch throw on the
    // header, and the catch below reports it as "could not reach PagerDuty" -
    // sending someone to check their network over a fixable paste. The steps
    // already refuse it with this message; Test Connection is where somebody
    // is most likely to have just pasted it.
    if (!isHeaderSafeToken(token)) {
      return {
        success: false,
        error:
          "The API token contains characters that cannot go in a request header - it was probably pasted with a line break or a space. Re-copy it from PagerDuty.",
      };
    }
    return { header: `Token token=${token}` };
  }

  const clientId = credentials.PAGERDUTY_OAUTH_CLIENT_ID?.trim();
  const clientSecret = credentials.PAGERDUTY_OAUTH_CLIENT_SECRET?.trim();
  const subdomain = credentials.PAGERDUTY_SUBDOMAIN?.trim();
  if (!(clientId && clientSecret && subdomain)) {
    return {
      success: false,
      error:
        "Add a REST API token, or an OAuth client id, client secret and subdomain.",
    };
  }

  const response = await fetch(PAGERDUTY_IDENTITY_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
      scope: pagerDutyOAuthScope(region === "eu", subdomain, OAUTH_SCOPES),
    }).toString(),
    signal: AbortSignal.timeout(PAGERDUTY_REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    if (response.status === 400 || response.status === 401) {
      if (probing) {
        return {
          success: false,
          error: "PagerDuty rejected the OAuth client credentials.",
        };
      }
      // The region is inside the scope string, not the host, so a scoped app
      // on the wrong region is rejected here rather than at /services - which
      // is where the region probe lives. Without this the EU checkbox's own
      // promise ("Test Connection checks the other region for you") held only
      // for API tokens, and an EU customer with a correct app was told their
      // client id and secret were wrong.
      const otherIsRight = await oauthTokenIssues(
        clientId,
        clientSecret,
        subdomain,
        region === "eu" ? "us" : "eu"
      );
      return {
        success: false,
        error: otherIsRight
          ? `PagerDuty rejected these credentials for the ${region === "eu" ? "EU" : "US"} region but accepted them for the ${region === "eu" ? "US" : "EU"} one. ${region === "eu" ? "Untick" : "Tick"} the EU service region checkbox.`
          : "PagerDuty rejected the OAuth client credentials. Check the client id, secret and subdomain, and that the app has services.read and escalation_policies.read.",
      };
    }
    return {
      success: false,
      error: `PagerDuty could not issue an OAuth token (HTTP ${response.status}).`,
    };
  }

  const parsed = (await response.json()) as { access_token?: string };
  if (!parsed.access_token) {
    return { success: false, error: "PagerDuty returned no access token." };
  }
  return { header: `Bearer ${parsed.access_token}` };
}

/**
 * Whether these client credentials issue a token for the other region.
 *
 * One request, and only reached on a rejection, so it costs nothing in the
 * normal case. Any failure here is reported as "no", because the question is
 * only ever asked to sharpen an error message that is already going out.
 */
async function oauthTokenIssues(
  clientId: string,
  clientSecret: string,
  subdomain: string,
  region: "us" | "eu"
): Promise<boolean> {
  try {
    const probe = await fetch(PAGERDUTY_IDENTITY_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: clientId,
        client_secret: clientSecret,
        scope: pagerDutyOAuthScope(region === "eu", subdomain, OAUTH_SCOPES),
      }).toString(),
      signal: AbortSignal.timeout(PAGERDUTY_REQUEST_TIMEOUT_MS),
    });
    return probe.ok;
  } catch {
    return false;
  }
}

function describeStatus(status: number): string {
  if (status === 401) {
    return "PagerDuty rejected the credentials. Check the token was copied in full.";
  }
  if (status === 403) {
    return "The credentials are valid but cannot read services. A read-only API key works; a scoped OAuth app needs services.read.";
  }
  if (status === 429) {
    return "PagerDuty rate limited the check. Try again in a minute.";
  }
  return `PagerDuty returned HTTP ${status}.`;
}

async function listServices(host: string, header: string): Promise<Response> {
  return await fetch(`${host}/services?limit=1`, {
    method: "GET",
    headers: { Authorization: header, Accept: PAGERDUTY_ACCEPT_V2 },
    signal: AbortSignal.timeout(PAGERDUTY_REQUEST_TIMEOUT_MS),
  });
}

/**
 * A credential presented to the wrong regional host comes back as a plain 401,
 * which reads exactly like a mistyped token and sends people hunting in the
 * wrong place. On a 401 the other region is tried once: if it answers, the
 * region checkbox is the fault and the message says so.
 */
async function describeAuthFailure(
  credentials: Record<string, string>,
  region: "us" | "eu",
  status: number
): Promise<string> {
  if (status !== 401) {
    return describeStatus(status);
  }

  const otherRegion = region === "eu" ? "us" : "eu";
  const otherHost =
    otherRegion === "eu" ? PAGERDUTY_API_HOST_EU : PAGERDUTY_API_HOST;
  // A connection with no API token cannot have a mistyped one, and telling
  // somebody to check a token they never entered sends them looking at a
  // field they cannot fix.
  const hasToken = Boolean(credentials.PAGERDUTY_API_TOKEN?.trim());
  const fallback = hasToken
    ? describeStatus(status)
    : "PagerDuty rejected these OAuth credentials for this account. Check the app has services.read and escalation_policies.read, and that the subdomain matches the account.";
  try {
    const auth = await resolveHeader(credentials, otherRegion, true);
    if ("header" in auth) {
      const response = await listServices(otherHost, auth.header);
      if (response.ok) {
        return otherRegion === "eu"
          ? "These credentials belong to a PagerDuty account in the EU service region. Tick EU service region."
          : "These credentials belong to a PagerDuty account in the US service region. Untick EU service region.";
      }
    }
  } catch {
    // The probe is a diagnostic: if it cannot run, fall through to the plain
    // message rather than turning a 401 into a network error.
  }
  return fallback;
}

export async function testPagerDuty(
  credentials: Record<string, string>
): Promise<TestResult> {
  try {
    const region = isEuRegionFlag(credentials.PAGERDUTY_EU_REGION)
      ? "eu"
      : "us";
    const host = region === "eu" ? PAGERDUTY_API_HOST_EU : PAGERDUTY_API_HOST;

    const auth = await resolveHeader(credentials, region);
    if (!("header" in auth)) {
      return auth;
    }

    const response = await listServices(host, auth.header);

    if (!response.ok) {
      return {
        success: false,
        error: await describeAuthFailure(credentials, region, response.status),
      };
    }

    return { success: true };
  } catch (error) {
    // A dropped connection between KeeperHub and PagerDuty is not a bad
    // token, and saying so stops someone rotating a perfectly good key
    // because the network blinked while they were setting it up.
    return {
      success: false,
      error: `Could not reach PagerDuty (${error instanceof Error ? error.message : String(error)}). The credentials were not checked - try again once the connection is back.`,
    };
  }
}
