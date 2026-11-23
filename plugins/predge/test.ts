import { stripTrailingSlashes } from "@/lib/utils/url";

const FETCH_TIMEOUT_MS = 10_000;

// Paired with DEFAULT_PREDGE_SIGNAL_URL and DEFAULT_PINNED_SIGNER in
// steps/predge-core.ts. This file is reachable from the client-bundled plugin
// registry and cannot import that server-only module, so both values are
// restated here and have to change together: a pin that drifts would make this
// test check a different key from the one the step verifies against.
const DEFAULT_PREDGE_SIGNAL_URL = "https://api.predge.io";
const DEFAULT_PINNED_SIGNER =
  "13fa3d18a369e6c71bf941563ba47822b30182273d5106a0e8fb61c5016352d9";

type PinnedKeyStatus = "current" | "retired" | "absent" | "not-a-keyset";

// Where the pinned key stands in the published keyset. Under the keyset's own
// rotation notice a replaced key stays listed with `active: false`, so being
// listed is not enough: the pin has to be the active attestation key, or every
// signal fails with "signer is not the pinned Predge key" at run time.
function pinnedKeyStatus(keyset: unknown, pinned: string): PinnedKeyStatus {
  const keys = (keyset as { keys?: unknown } | null)?.keys;
  if (!Array.isArray(keys)) {
    return "not-a-keyset";
  }
  const entry = (keys as unknown[]).find((key) => {
    const publicKey = (key as { public_key?: unknown } | null)?.public_key;
    return typeof publicKey === "string" && publicKey.toLowerCase() === pinned;
  }) as { active?: unknown; role?: unknown } | undefined;
  if (!entry) {
    return "absent";
  }
  return entry.active === true && entry.role === "attestation"
    ? "current"
    : "retired";
}

function pinnedKeyError(
  status: "retired" | "absent",
  operatorPinned: boolean
): string {
  const where =
    status === "absent"
      ? "is not listed in the published keyset"
      : "is no longer the active attestation key in the published keyset";
  if (operatorPinned) {
    return `Your Pinned Signer Key ${where}, so signals will fail verification. Check the key.`;
  }
  return `The signing key this plugin pins ${where}, so signals will fail verification. Predge has rotated its key: set Pinned Signer Key to the new published key.`;
}

export async function testPredge(
  credentials: Record<string, string>
): Promise<{ success: boolean; error?: string }> {
  try {
    const rawUrl =
      credentials.PREDGE_SIGNAL_URL?.trim() || DEFAULT_PREDGE_SIGNAL_URL;
    const baseUrl = stripTrailingSlashes(rawUrl);
    const operatorKey = credentials.PREDGE_SIGNER_KEY_ID?.trim();
    const pinned = (operatorKey || DEFAULT_PINNED_SIGNER).toLowerCase();

    // Read-only: the published keyset confirms the signal service is reachable,
    // and that the key the step verifies against is still the one it signs
    // with, so a rotation shows up here rather than as failed runs.
    //
    // Redirects are not followed. handlePluginTest runs assertUrlIsPublic on
    // the configured URL before this function is loaded, but nothing checks
    // where a redirect points: the raw fetch global has no per-hop guard (the
    // connector inside safeFetch is what validates each hop, and this file
    // cannot import it). Following one would let a public URL steer this
    // request to an internal address and report back its status. The signal
    // service answers this path directly, as plugins/agent-gateway/test.ts
    // already assumes of its own host.
    const response = await fetch(`${baseUrl}/.well-known/predge-keys.json`, {
      method: "GET",
      redirect: "manual",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (response.status >= 300 && response.status < 400) {
      return {
        success: false,
        error: `Predge signal service redirected (HTTP ${response.status}) and the connection test does not follow redirects. Set the signal URL to the address that serves /.well-known/predge-keys.json.`,
      };
    }

    if (!response.ok) {
      return {
        success: false,
        error: `Predge signal service returned HTTP ${response.status}. Check the signal URL.`,
      };
    }

    const keyset: unknown = await response.json().catch(() => null);
    const status = pinnedKeyStatus(keyset, pinned);
    if (status === "current") {
      return { success: true };
    }
    if (status === "not-a-keyset") {
      return {
        success: false,
        error:
          "The signal service did not return a Predge keyset at /.well-known/predge-keys.json. Check the signal URL.",
      };
    }
    return {
      success: false,
      error: pinnedKeyError(status, Boolean(operatorKey)),
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
