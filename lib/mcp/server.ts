import {
  McpServer,
  ResourceTemplate,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AuthMethod } from "@/lib/middleware/auth-helpers";
import { PUBLIC_TOOLS, SCOPE_MCP_PUBLIC } from "./oauth-scopes";
import { registerMetaTools, registerTools } from "./tools";

/**
 * Wrap an McpServer so `registerTools`/`registerMetaTools` can only register
 * tools that are in PUBLIC_TOOLS. `tools/list` reflects *registered* tools
 * (scope only gates calls), so for the anonymous public surface we must drop
 * non-public tools at registration time -- otherwise an anonymous list would
 * leak the full org/write catalog. All other server methods pass through bound
 * to the real instance (so the SDK's private class fields keep working).
 */
export function publicToolRegistrar(server: McpServer): McpServer {
  return new Proxy(server, {
    get(target, prop, receiver) {
      if (prop === "tool") {
        const register = target.tool.bind(target);
        return (name: string, ...rest: unknown[]): unknown => {
          if (!PUBLIC_TOOLS.has(name)) {
            return;
          }
          // biome-ignore lint/suspicious/noExplicitAny: forwarding the SDK's overloaded tool() signature verbatim
          return (register as (...a: any[]) => unknown)(name, ...rest);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function fetchJson(
  internalApiBaseUrl: string,
  authHeader: string,
  path: string
): Promise<unknown> {
  const response = await fetch(`${internalApiBaseUrl}${path}`, {
    headers: {
      "Content-Type": "application/json",
      Authorization: authHeader,
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `API call failed: ${response.status} ${response.statusText} - ${errorText}`
    );
  }

  return response.json();
}

function registerResources(
  server: McpServer,
  internalApiBaseUrl: string,
  authHeader: string
): void {
  server.resource(
    "workflows-list",
    "keeperhub://workflows",
    { description: "List all workflows for the authenticated organization" },
    async (_uri) => {
      const data = await fetchJson(
        internalApiBaseUrl,
        authHeader,
        "/api/workflows"
      );
      return {
        contents: [
          {
            uri: "keeperhub://workflows",
            mimeType: "application/json",
            text: JSON.stringify(data, null, 2),
          },
        ],
      };
    }
  );

  const workflowTemplate = new ResourceTemplate("keeperhub://workflows/{id}", {
    list: undefined,
  });

  server.resource(
    "workflow-by-id",
    workflowTemplate,
    { description: "Get a specific workflow by ID" },
    async (_uri, variables) => {
      const id = variables.id;
      const data = await fetchJson(
        internalApiBaseUrl,
        authHeader,
        `/api/workflows/${id}`
      );
      return {
        contents: [
          {
            uri: `keeperhub://workflows/${id}`,
            mimeType: "application/json",
            text: JSON.stringify(data, null, 2),
          },
        ],
      };
    }
  );
}

export function createMcpServer(
  internalApiBaseUrl: string,
  authHeader: string,
  scope?: string,
  credentialType?: AuthMethod
): McpServer {
  const server = new McpServer({
    name: "keeperhub",
    version: "1.2.0",
  });

  const isPublic = scope === SCOPE_MCP_PUBLIC;
  const registrar = isPublic ? publicToolRegistrar(server) : server;

  registerTools(
    registrar,
    internalApiBaseUrl,
    authHeader,
    scope,
    credentialType
  );
  registerMetaTools(
    registrar,
    internalApiBaseUrl,
    authHeader,
    scope,
    credentialType
  );

  // Resources (keeperhub://workflows*) read org-scoped data, so they are never
  // registered on the anonymous public surface.
  if (!isPublic) {
    registerResources(server, internalApiBaseUrl, authHeader);
  }

  return server;
}
