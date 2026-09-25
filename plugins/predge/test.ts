import { ErrorCategory, logUserError } from "@/lib/logging";
import {
  assertUrlIsPublic,
  safeFetch,
  SsrfBlockedError,
} from "@/lib/safe-fetch";
import { getErrorMessage } from "@/lib/utils";
import { stripTrailingSlashes } from "@/lib/utils/url";

const DEFAULT_PREDGE_SIGNAL_URL = "https://api.predge.io";

// Same budget the signal fetch uses, so a stalled host cannot hold the
// credentials dialog open either.
const FETCH_TIMEOUT_MS = 10_000;

function isParseableUrl(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Connection test for the credentials dialog. Read-only GET of the published
 * keyset, which confirms the signal service is reachable and is serving Predge
 * signing keys.
 *
 * The base URL comes from operator-supplied credentials, so this is an outbound
 * request to an address the operator chose, and it goes through the same
 * always-on `assertUrlIsPublic` guard as the signal fetch. Without it this test
 * doubles as an internal-network probe: the HTTP status it reports back tells
 * the caller which private hosts and ports answer.
 */
export async function testPredge(
  credentials: Record<string, string>
): Promise<{ success: boolean; error?: string }> {
  const rawUrl =
    credentials.PREDGE_SIGNAL_URL?.trim() || DEFAULT_PREDGE_SIGNAL_URL;
  const baseUrl = stripTrailingSlashes(rawUrl);
  const url = `${baseUrl}/.well-known/predge-keys.json`;

  // An operator can type a base URL with no scheme ("api.predge.io").
  // assertUrlIsPublic throws a plain TypeError on that, which would be shown as
  // Predge being unreachable rather than as the typo it is.
  if (!isParseableUrl(url)) {
    return {
      success: false,
      error: `Predge signal URL is not a valid URL: ${url}`,
    };
  }

  try {
    await assertUrlIsPublic(url);

    const response = await safeFetch(url, {
      plugin: "predge",
      method: "GET",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (!response.ok) {
      return {
        success: false,
        error: `Predge signal service returned HTTP ${response.status}. Check the signal URL.`,
      };
    }

    return { success: true };
  } catch (error) {
    if (error instanceof SsrfBlockedError) {
      logUserError(
        ErrorCategory.VALIDATION,
        "[Predge] Blocked SSRF target in connection test",
        error.message,
        { plugin_name: "predge" }
      );
      return {
        success: false,
        error: `Predge signal URL is not allowed: ${error.message}`,
      };
    }
    return {
      success: false,
      error: getErrorMessage(error),
    };
  }
}
