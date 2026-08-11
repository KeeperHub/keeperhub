# KEEP-1164: Workflow Templates Feature

## Overview

Add a curated templates system for workflows created and managed by the KeeperHub internal team. Templates are distinct from user-shared public workflows - they have richer metadata and are promoted via an internal hub service endpoint.

## User Flow

1. User visits Hub page
2. Templates section displays curated workflows with descriptions and categories
3. User clicks "Use Template"
4. Existing duplicate flow creates a private copy in their organization
5. User configures their own integrations and customizes the workflow

## Database Changes

Add 3 fields to the `workflows` table in `lib/db/schema.ts`:

```typescript
// start custom keeperhub code //
featured: boolean("featured").default(false).notNull(),
category: text("category"),
featuredOrder: integer("featured_order").default(0),
// end keeperhub code //
```

| Field | Type | Description |
|-------|------|-------------|
| `featured` | boolean | Flag that marks workflow as a featured template |
| `category` | text | Optional. Category for grouping (e.g., "Web3", "Notifications") |
| `featuredOrder` | integer | Sort priority (higher = appears first) |

Note: `description` already exists on the workflow table.

## API Changes

### 1. Hub Service Endpoint: Promote/Update Featured Workflow

**Route:** `POST /keeperhub/api/hub/featured`

**Authentication:** Internal service HMAC signature via `X-KH-Caller` / `X-KH-Timestamp` / `X-KH-Signature` headers

**Environment Variable:** `INTERNAL_SERVICE_HMAC_SECRET`

**Request Body:**
```typescript
{
  workflowId: string;          // Required - workflow to promote
  featured?: boolean;          // Default: true (set false to demote)
  category?: string;           // Optional. Category name
  featuredOrder?: number;      // Sort priority
}
```

**Response:**
```typescript
{
  success: true;
  workflow: {
    id: string;
    name: string;
    featured: boolean;
    category: string | null;
    featuredOrder: number;
  }
}
```

**Usage:**
```bash
curl -X POST https://app.keeperhub.com/api/hub/featured \
  -H "Content-Type: application/json" \
  -H "X-KH-Caller: hub" -H "X-KH-Timestamp: $TS" -H "X-KH-Signature: $SIG" \
  -d '{
    "workflowId": "abc123",
    "category": "Web3",
    "featuredOrder": 10
  }'
```

#### How Service Key Authentication Works

This endpoint extends the existing internal service authentication system at `keeperhub/lib/internal-service-auth.ts`. The system already authenticates requests from internal K8s services (scheduler, events, mcp).

**Extending the existing system:**

1. Add `"hub"` to the `InternalServiceName` type:
```typescript
export type InternalServiceName = "mcp" | "events" | "scheduler" | "hub";
```

2. Add the key mapping in `SERVICE_KEYS`:
```typescript
const SERVICE_KEYS: Record<InternalServiceName, string | undefined> = {
  mcp: process.env.MCP_SERVICE_API_KEY,
  events: process.env.EVENTS_SERVICE_API_KEY,
  scheduler: process.env.SCHEDULER_SERVICE_API_KEY,
  hub: process.env.HUB_SERVICE_API_KEY,  // new
};
```

**Authentication flow:**
1. Request includes `X-KH-Caller` / `X-KH-Timestamp` / `X-KH-Signature` headers, where the
   signature is `hmac_sha256(secret, "POST\n/api/hub/featured\nhub\nsha256(body)\ntimestamp")`
2. Server verifies the timestamp is within the replay window and recomputes the signature
   using the shared secret from the `internal_service_hmac_secrets` store
3. Uses timing-safe comparison (`crypto.timingSafeEqual`) on the signature bytes
4. Returns `{ authenticated: true, caller: "hub" }` on success

**Endpoint authorization:**
```typescript
const auth = authenticateInternalService(request);
if (!auth.authenticated || auth.service !== 'hub') {
  return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
}
```

#### Field Restriction (Allowlist)

The hub service endpoint restricts which workflow fields can be modified. Only featured-specific fields are editable:

```typescript
const ALLOWED_FEATURED_FIELDS = [
  'featured',
  'category',
  'featuredOrder',
] as const;
```

**What this prevents:**
- Cannot modify `name`, `description`, `nodes`, `edges`, `userId`, `orgId`, or any other workflow field
- Extra fields in the request body are silently ignored
- Provides defense-in-depth even if the service key is compromised

### 2. Update Public Workflows Endpoint

**Route:** `GET /api/workflows/public`

**New Query Parameter:** `featured=true`

**Behavior:**
- `?featured=true` - Returns only workflows where `featured = true`, ordered by `featuredOrder DESC, updatedAt DESC`
- No parameter or `featured=false` - Returns public workflows where `featured = false` (existing behavior)

**Response Addition:**
```typescript
{
  // Existing fields...
  featured: boolean;
  category: string | null;
  featuredOrder: number;
}
```

## Frontend Changes

### Hub Page Updates

Location: `app/hub/page.tsx` and `keeperhub/components/hub/workflow-template-grid.tsx`

1. Fetch featured workflows via `/api/workflows/public?featured=true`
2. Display featured section with:
   - Workflow mini-map diagram
   - Name and description
   - Category badge (if set)
3. Sort by `featuredOrder` (already handled by API)
4. Keep existing "Use Template" button and duplicate flow

### Template Card Component

Create or update card to display:
- Workflow mini-map diagram (auto-generated from nodes/edges)
- Template name
- Description (line-clamp-2)
- Category badge (optional)
- "Use Template" action button

## File Locations

Following KeeperHub custom code policy:

| Change | Location |
|--------|----------|
| Schema fields | `lib/db/schema.ts` (within markers) |
| Hub service endpoint | `keeperhub/api/hub/featured/route.ts` |
| Service auth update | `keeperhub/lib/internal-service-auth.ts` |
| Public API filter | `app/api/workflows/public/route.ts` (within markers) |
| Hub UI updates | `keeperhub/components/hub/workflow-template-grid.tsx` |

## Implementation Steps

1. Add schema fields to `lib/db/schema.ts`
2. Run `pnpm db:push` to apply migration
3. Add `hub` to allowed services in `internal-service-auth.ts`
4. Create hub service endpoint at `keeperhub/api/hub/featured/route.ts`
5. Update `/api/workflows/public` to support `?featured=true` filter
6. Update Hub UI to fetch and display featured workflows
7. Add `HUB_SERVICE_API_KEY` to environment variables

## Environment Variables

```
HUB_SERVICE_API_KEY=<generate-secure-key>
```

## Security Considerations

- Hub service endpoint protected by service key (not exposed to users)
- Timing-safe key comparison prevents timing attacks
- Field allowlist restricts hub service to template-specific fields only (defense-in-depth)
- Templates inherit existing public workflow sanitization (integration IDs stripped)
- Duplicate flow already handles safe copying

## Out of Scope

- Template versioning
- Admin UI for managing templates
- Template analytics/usage tracking
