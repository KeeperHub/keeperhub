/**
 * Pull the raw revert data out of an ethers.js error, wherever the provider
 * nested it. Returns undefined when the node returned none at all.
 *
 * Exported so callers can tell apart the two cases `decodeRevertReason`
 * collapses into `undefined`: "the node returned no revert data" (a rejected
 * estimate, an underfunded sender) versus "revert data came back but no
 * known ABI decodes it" (an unlisted custom error). The follow-up action
 * differs, so the two must not be treated as the same answer.
 */
export function extractRevertData(error: unknown): string | undefined {
  if (!error || typeof error !== "object") {
    return;
  }
  const err = error as Record<string, unknown>;

  // ethers.js v6 CALL_EXCEPTION puts revert data in .data
  if (typeof err.data === "string" && err.data.startsWith("0x")) {
    return err.data;
  }

  // Some errors nest it under .error
  if (err.error && typeof err.error === "object") {
    return extractRevertData(err.error);
  }

  // Some RPC errors put it in .info.error.data
  if (err.info && typeof err.info === "object") {
    return extractRevertData(err.info);
  }

  return;
}

/** The JSON-RPC error object ethers keeps on an error the node answered with. */
export function rpcErrorOf(
  error: unknown
): { code?: unknown; message?: unknown } | undefined {
  const e = error as { info?: { error?: unknown }; error?: unknown } | null;
  const candidate = e?.info?.error ?? e?.error;
  return candidate && typeof candidate === "object"
    ? (candidate as { code?: unknown; message?: unknown })
    : undefined;
}
