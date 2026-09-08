type JsonRpcMessage = Record<string, unknown>;

function normalizeMessage(message: unknown): unknown {
  if (
    !message ||
    typeof message !== "object" ||
    (message as JsonRpcMessage).method !== "tools/call"
  ) {
    return message;
  }

  // By-position `params` (a JSON-RPC 2.0 array) is not a shape MCP uses, and
  // spreading one would silently rewrite it into an object. Leave it alone and
  // let the SDK reject it on its own terms.
  const params = (message as JsonRpcMessage).params;
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    return message;
  }

  const args = (params as JsonRpcMessage).arguments;
  if (args !== null && args !== undefined) {
    return message;
  }

  return {
    ...(message as JsonRpcMessage),
    params: { ...(params as JsonRpcMessage), arguments: {} },
  };
}

/**
 * A `tools/call` with `arguments` explicitly `null` fails the SDK's
 * `z.record().optional()` params schema with a raw Zod error, which the
 * transport surfaces as -32603 (Internal error) rather than a validation
 * error - indistinguishable from the server being down. Omitting the key
 * entirely already parses fine at this schema and fails one layer in with a
 * proper tool-scoped error instead, so it isn't broken the same way - but on
 * a tool with no required parameters it should just run. Defaulting both
 * shapes to `{}` here, before the request reaches the SDK, fixes the null
 * case's opaque error and lets an all-optional tool run without an
 * arguments key, while every per-tool schema (e.g. get_wallet_integration's
 * required `integrationId`) is still enforced downstream unchanged.
 */
export function normalizeToolCallArguments(body: unknown): unknown {
  return Array.isArray(body)
    ? body.map(normalizeMessage)
    : normalizeMessage(body);
}
