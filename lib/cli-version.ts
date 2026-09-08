/**
 * The oldest `kh` CLI release this deployment considers supported.
 *
 * Every CLI request carries `KH-CLI-Version`, and the CLI compares its own
 * version against the `KH-Minimum-CLI-Version` response header on every
 * response (internal/http/version.go). Older builds print a warning to stderr;
 * nothing is blocked, so raising this floor degrades gracefully.
 *
 * The floor is 0.11.1 because 0.11.0 is the last release whose device login
 * could not work: it stores whatever `/device/token` returns, and before the
 * API-key swap that was a Better Auth session token, which no server auth path
 * accepts from a CLI. Any release carrying the fix sorts above 0.11.1, so the
 * warning reaches exactly the users who need to upgrade.
 *
 * Override per environment with KH_MINIMUM_CLI_VERSION to raise the floor
 * without a code change.
 */
export const MINIMUM_CLI_VERSION =
  process.env.KH_MINIMUM_CLI_VERSION ?? "0.11.1";

export const MINIMUM_CLI_VERSION_HEADER = "KH-Minimum-CLI-Version";

/**
 * The next.config `headers()` rule that advertises the floor on API routes,
 * kept here so it can be asserted directly - next.config's default export is
 * wrapped by withSentryConfig/withWorkflow and does not expose a callable
 * headers() to import.
 */
export const CLI_VERSION_HEADER_RULE: {
  source: string;
  headers: Array<{ key: string; value: string }>;
} = {
  source: "/api/:path*",
  headers: [{ key: MINIMUM_CLI_VERSION_HEADER, value: MINIMUM_CLI_VERSION }],
};
