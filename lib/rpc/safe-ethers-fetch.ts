import "server-only";

import type { FetchGetUrlFunc, FetchRequest, GetUrlResponse } from "ethers";
import { safeFetch } from "@/lib/safe-fetch";

/**
 * ethers v6 `FetchGetUrlFunc` that proxies the underlying HTTP call through
 * `safeFetch`, so user-supplied RPC URLs go through the SSRF guard.
 *
 * ethers' default `getUrlFunc` uses Node's global fetch (or its own undici
 * dispatcher) and bypasses our denylist. Per-instance assignment via
 * `fetchRequest.getUrlFunc = safeEthersGetUrl` is preferred over
 * `FetchRequest.registerGetUrl` (global) so this only redirects user-RPC
 * traffic — ethers internals like ENS resolution stay on the default path.
 */
export const safeEthersGetUrl: FetchGetUrlFunc = async (
  req: FetchRequest
): Promise<GetUrlResponse> => {
  // ethers' `req.body` is `null | Uint8Array`. The DOM `BodyInit` typing
  // accepts BufferSource but is too narrow for the parameterised
  // `Uint8Array<ArrayBufferLike>` ethers exposes — cast through BodyInit
  // to satisfy tsc without changing runtime behaviour (undici accepts it).
  const body = (req.body ?? undefined) as BodyInit | undefined;

  const response = await safeFetch(req.url, {
    method: req.method,
    headers: req.headers,
    body,
    plugin: "rpc-evm",
  });

  const buf = await response.arrayBuffer();
  const responseHeaders: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    responseHeaders[key] = value;
  });

  return {
    statusCode: response.status,
    statusMessage: response.statusText,
    headers: responseHeaders,
    body: buf.byteLength > 0 ? new Uint8Array(buf) : null,
  };
};
