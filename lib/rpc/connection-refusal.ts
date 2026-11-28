import { rpcErrorOf } from "@/lib/web3/revert-data";

// No node took the request: refused, or host not resolved / blocked.
const REFUSED_CODES: ReadonlySet<string> = new Set(["ECONNREFUSED"]);
const UNREACHED_CODES: ReadonlySet<string> = new Set([
  "ENOTFOUND",
  "SSRF_BLOCKED",
]);
const REFUSED_TEXT = /econnrefused|connection refused/i;
const UNREACHED_TEXT = /enotfound/i;

/** Why a request never reached a node. */
type NeverReached = "refused" | "unreachable";

/** A JSON-RPC error a node answered with: its text is the node's, not ours. */
function nodeAnswered(error: unknown): boolean {
  return typeof rpcErrorOf(error)?.code === "number";
}

/** An HTTP answer (ethers SERVER_ERROR): its body is a gateway's, not our connection. */
function httpAnswered(error: unknown): boolean {
  const e = error as {
    code?: unknown;
    info?: { responseStatus?: unknown };
  } | null;
  return (
    e?.code === "SERVER_ERROR" || typeof e?.info?.responseStatus === "number"
  );
}

function socketCode(error: unknown): NeverReached | undefined {
  // fetch and ethers wrap the socket error; look a few levels deep.
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && REFUSED_CODES.has(code)) {
      return "refused";
    }
    if (typeof code === "string" && UNREACHED_CODES.has(code)) {
      return "unreachable";
    }
    const next = current as { cause?: unknown; error?: unknown };
    current = next.cause ?? next.error;
  }
  return;
}

/**
 * Why the request never reached a node, if it is known. Neither the RPC
 * transport nor extra URLs follow redirects, so a refusal code or text means
 * the one endpoint asked never took the bytes. The text is trusted only off a
 * node's or gateway's answer: it is the socket error's or our failover summary's.
 */
export function neverReached(error: unknown): NeverReached | undefined {
  const code = socketCode(error);
  if (code) {
    return code;
  }
  if (nodeAnswered(error) || httpAnswered(error)) {
    return;
  }
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (REFUSED_TEXT.test(message)) {
    return "refused";
  }
  return UNREACHED_TEXT.test(message) ? "unreachable" : undefined;
}

/**
 * The request never reached a node. The one reading for the route, the
 * pre-broadcast verdict, the failover's all-refused flag and extras.
 */
export function isConnectionRefusal(error: unknown): boolean {
  return neverReached(error) !== undefined;
}
