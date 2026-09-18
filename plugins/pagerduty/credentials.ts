/**
 * Credentials a PagerDuty connection can hold.
 *
 * Two authentication shapes, both read-only as far as this plugin is
 * concerned: a REST API token, or a scoped OAuth app whose client credentials
 * are exchanged for a short-lived bearer token. Paging itself is authorised by
 * the routing key of the service's own Events API v2 integration, which the
 * plugin resolves at run time and never stores.
 */
export type PagerDutyCredentials = {
  /** General access or user REST API key. Read-only is enough for every Events action. */
  PAGERDUTY_API_TOKEN?: string;
  /** Scoped OAuth app client id, used when no API token is set. */
  PAGERDUTY_OAUTH_CLIENT_ID?: string;
  PAGERDUTY_OAUTH_CLIENT_SECRET?: string;
  /** Account subdomain, e.g. "acme" for acme.pagerduty.com. Required by the OAuth scope string. */
  PAGERDUTY_SUBDOMAIN?: string;
  /** "true" when the account lives in the EU service region. */
  PAGERDUTY_EU_REGION?: string;
  /** Login email of a PagerDuty user. Only the REST create-incident action needs it. */
  PAGERDUTY_FROM_EMAIL?: string;
};
