import { GET as rootMetadata } from "../route";

export const dynamic = "force-dynamic";

// Path-scoped Protected Resource Metadata per RFC 9728 §3.1. Some strict MCP
// clients construct the metadata URL by appending the resource path to the
// .well-known prefix (e.g. Notion's MCP) instead of following the
// WWW-Authenticate hint. Serve the same document at both mounts so either
// discovery strategy resolves.
export function GET(request: Request): Response {
  return rootMetadata(request);
}
