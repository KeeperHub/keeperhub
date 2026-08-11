# KeeperHub MCP Server Specification

## Overview

Create a standalone MCP (Model Context Protocol) server for KeeperHub that enables AI agents to create, manage, and execute blockchain automation workflows. The server will be a TypeScript/Node.js Docker container that authenticates via API keys and exposes full CRUD operations, AI-powered workflow generation, and async execution monitoring through MCP tools and resources.

## Requirements

### Core Functionality
- **Full CRUD operations** for workflows (create, read, update, delete)
- **AI-powered workflow generation** via natural language (reuse existing `/api/ai/generate` logic)
- **Async execution** with polling for status/logs
- **MCP Resources** exposing workflow definitions and execution history

### Authentication & Authorization
- **API Key authentication** - one key per organization
- **API key management UI** in KeeperHub app settings (generate/revoke keys)
- **Single org scope** - each API key bound to one organization

### Architecture
- **Separate repository** (`KeeperHub/keeperhub-mcp`)
- **TypeScript/Node.js** runtime for type sharing with main app
- **Docker container** distribution (similar to Terraform MCP pattern)
- **Calls KeeperHub REST APIs** for all operations

## MCP Tools

| Tool | Description | Parameters |
|------|-------------|------------|
| `list_workflows` | List workflows in the org | `limit?`, `offset?` |
| `get_workflow` | Get workflow details by ID | `workflow_id` |
| `create_workflow` | Create a new workflow | `name`, `description?`, `nodes?`, `edges?` |
| `update_workflow` | Update workflow nodes/edges | `workflow_id`, `name?`, `description?`, `nodes?`, `edges?` |
| `delete_workflow` | Delete a workflow | `workflow_id` |
| `generate_workflow` | AI-powered generation from natural language | `prompt`, `existing_workflow?` |
| `execute_workflow` | Start async execution | `workflow_id`, `input?` |
| `get_execution_status` | Poll execution status | `execution_id` |
| `get_execution_logs` | Get execution logs | `execution_id` |

## MCP Resources

| Resource URI | Description |
|--------------|-------------|
| `workflows://list` | All workflows in org |
| `workflows://{id}` | Single workflow definition |
| `executions://{id}` | Execution details and logs |

## Technical Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     Claude Code / AI Agent                       │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│   MCP Client (stdio)                                            │
│                                                                  │
└─────────────────────┬───────────────────────────────────────────┘
                      │ stdin/stdout
                      ▼
┌─────────────────────────────────────────────────────────────────┐
│                  KeeperHub MCP Server                            │
│                  (Docker Container)                              │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│   ┌─────────────┐  ┌─────────────┐  ┌─────────────┐            │
│   │   Tools     │  │  Resources  │  │   HTTP      │            │
│   │   Handler   │  │   Handler   │  │   Client    │            │
│   └──────┬──────┘  └──────┬──────┘  └──────┬──────┘            │
│          │                │                │                    │
│          └────────────────┴────────────────┘                    │
│                           │                                      │
│                     API Key Auth                                 │
│                           │                                      │
└───────────────────────────┼─────────────────────────────────────┘
                            │ HTTPS
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│                     KeeperHub API                                │
│                 (app.keeperhub.com)                             │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│   /api/workflows/*        - Workflow CRUD                       │
│   /api/workflow/*/execute - Execution                           │
│   /api/ai/generate        - AI Generation                       │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

## MCP Server Implementation

### Repository Structure

```
keeperhub-mcp/
├── src/
│   ├── index.ts              # MCP server entry point
│   ├── tools/
│   │   ├── workflows.ts      # Workflow CRUD tools
│   │   ├── executions.ts     # Execution tools
│   │   └── generate.ts       # AI generation tool
│   ├── resources/
│   │   ├── workflows.ts      # Workflow resources
│   │   └── executions.ts     # Execution resources
│   ├── client/
│   │   └── keeperhub.ts      # KeeperHub API client
│   └── types/
│       └── index.ts          # Shared types
├── Dockerfile
├── package.json
├── tsconfig.json
└── README.md
```

### Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `KEEPERHUB_API_KEY` | Organization API key | Yes |
| `KEEPERHUB_API_URL` | API base URL (default: `https://app.keeperhub.com`) | No |

### Docker Configuration

```dockerfile
FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-alpine
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY package.json ./
CMD ["node", "dist/index.js"]
```

### MCP Client Configuration

```json
{
  "mcpServers": {
    "keeperhub": {
      "command": "docker",
      "args": [
        "run",
        "-i",
        "--rm",
        "-e",
        "KEEPERHUB_API_KEY",
        "KeeperHub/keeperhub-mcp"
      ]
    }
  }
}
```

## KeeperHub App Changes

### Database Schema

```sql
-- API keys table
CREATE TABLE api_keys (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    key_hash VARCHAR(64) NOT NULL,  -- SHA-256 hash of the key
    key_prefix VARCHAR(8) NOT NULL,  -- First 8 chars for identification
    created_by UUID REFERENCES "user"(id),
    created_at TIMESTAMP DEFAULT NOW(),
    last_used_at TIMESTAMP,
    expires_at TIMESTAMP,
    revoked_at TIMESTAMP,
    UNIQUE(key_hash)
);

CREATE INDEX idx_api_keys_org ON api_keys(organization_id);
CREATE INDEX idx_api_keys_hash ON api_keys(key_hash);
```

### API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/keys` | GET | List API keys for current org |
| `/api/keys` | POST | Create new API key |
| `/api/keys/[keyId]` | DELETE | Revoke API key |

### Auth Middleware

Add API key authentication to existing workflow endpoints:

```typescript
// Check for API key in Authorization header
// Format: Bearer kh_xxxxx
async function authenticateApiKey(request: Request) {
  const authHeader = request.headers.get('Authorization');
  if (authHeader?.startsWith('Bearer kh_')) {
    const key = authHeader.substring(7);
    const keyHash = sha256(key);
    const apiKey = await db.query.apiKeys.findFirst({
      where: and(
        eq(apiKeys.keyHash, keyHash),
        isNull(apiKeys.revokedAt)
      )
    });
    if (apiKey) {
      // Update last_used_at
      await db.update(apiKeys)
        .set({ lastUsedAt: new Date() })
        .where(eq(apiKeys.id, apiKey.id));
      return { orgId: apiKey.organizationId };
    }
  }
  return null;
}
```

### UI Components

Add to organization settings:
- API Keys list view
- Create API key modal (shows key once, never again)
- Revoke API key confirmation

## Implementation Phases

### Phase 1: KeeperHub App Changes
1. Add `api_keys` table schema
2. Create API key management endpoints
3. Add API key auth middleware
4. Build API key settings UI

### Phase 2: MCP Server Core
1. Set up new repository
2. Implement MCP server with SDK
3. Build KeeperHub API client
4. Implement workflow CRUD tools

### Phase 3: Advanced Features
1. Add AI generation tool
2. Add execution tools
3. Implement MCP resources
4. Docker build and publish

### Phase 4: Documentation & Testing
1. Write README with usage examples
2. Add integration tests
3. Publish Docker image

## Open Questions

- Should we support streaming for AI workflow generation via MCP?
- Docker image naming: `KeeperHub/keeperhub-mcp` or `ghcr.io/KeeperHub/keeperhub-mcp`?

## Out of Scope

- Rate limiting (TODO for when pricing tiers are implemented)
- Multi-org API keys
- Webhook triggers via MCP
- Real-time execution streaming (use polling instead)

## Security Considerations

1. **API Key Storage**: Keys are hashed with SHA-256, only prefix shown in UI
2. **Key Rotation**: Users can create new keys and revoke old ones
3. **Audit Logging**: Track `last_used_at` for each key
4. **Expiration**: Optional expiration date for keys
5. **Scope Limitation**: Keys scoped to single organization
