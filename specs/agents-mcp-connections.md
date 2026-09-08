# Agents: MCP connection tracking and scope management

Draft. The Agents section currently shows only static setup instructions. This
turns it into a live view of who has connected an MCP client to the
organization, and gives admins control over what those clients may do.

## What a connection already is

No new concept is needed. A connection is a row in `mcp_oauth_refresh_tokens`:

| Column | Meaning |
|---|---|
| `clientId` | joins `mcp_oauth_clients` for the client's display name |
| `userId` | the person who consented |
| `organizationId` | the organization the client acts inside |
| `scope` | `mcp:read`, `mcp:write` or `mcp:admin` |
| `createdAt` | when the client was connected |
| `expiresAt` | 30 days out, renewed on refresh |

`mcp_oauth_clients` holds the registered client: `clientName`, `redirectUris`,
the scopes it asked for. One person connecting Claude Code twice produces two
rows; the list shows connections, not clients.

## The problem that shapes everything else

Access tokens are stateless. `createAccessToken` signs an HS256 JWT carrying
`sub`, `org` and `scope` with a one hour expiry, and `verifyAccessToken` checks
only the signature. Nothing reads the database.

So deleting a refresh token stops renewal but does not stop access: the token
already in the client's memory keeps working, at its original scope, until it
expires. A revoke button built on today's model would be honest for at most
"this client cannot renew", and misleading for the hour that matters.

### Revocation epoch

Add a per user, per organization counter that both the token and the verifier
know about.

- New table `mcp_scope_epochs(user_id, organization_id, epoch, updated_at)`,
  primary key on the pair.
- `createAccessToken` reads the current epoch and adds it to the JWT payload.
- `authenticateOAuthToken` compares the token's `epoch` against the current
  one and rejects on mismatch. This is the single chokepoint for every MCP
  call, so one check covers the whole surface.
- Any revoke or scope change bumps the epoch, which invalidates every live
  access token for that person in that organization at once.
- The read is cached in process for 30 seconds, so the steady state cost is
  nothing and the worst case delay is 30 seconds rather than an hour.

Tokens minted before this ships carry no `epoch`. Treat a missing claim as
epoch 0 and seed every row at 0, so existing connections keep working and the
first bump invalidates them.

### Why not the alternatives

Shortening the token TTL narrows the window without closing it and multiplies
refresh traffic. Reading the refresh token row on every call closes it exactly
but puts a database read in the hot path of every MCP tool call, which is the
cost the stateless design was chosen to avoid.

## Permissions

| | Sees | Revoke | Change scope | Org ceiling |
|---|---|---|---|---|
| Member | own connections | own | no | no |
| Admin | all in the org | any | any | yes |
| Owner | all in the org | any | any | yes |

Members see only what they connected. One person's agent use is not something
the whole organization needs to watch, and a member has no action to take on
someone else's connection anyway.

Scope editing is unrestricted in both directions, by decision. Two notes on
what that means, so the implementation compensates where it can:

- Widening grants a member's client more power than the member approved when
  they consented, and OAuth gives no way to tell the client this happened. The
  member sees the new scope on their own connection, and the change is
  audited with actor and before/after.
- It is not new authority. An admin can already mint an organization API key
  with full access, so this exposes a power admins hold rather than adding one.

## Surface

### Data

Add to `mcp_oauth_refresh_tokens`:

- `last_used_at timestamp`, written on refresh and on token verification
  (throttled to at most once a minute per row so it does not become a write
  per call).
- `revoked_at timestamp` so a revoked connection stays visible in history
  rather than vanishing.

Add `mcp_scope_epochs` as above. Add `max_scope` to the organization settings
that already exist, defaulting to `mcp:admin` so nothing changes on upgrade.

### Endpoints

- `GET /api/mcp/connections` returns the caller's connections, or every
  connection in the organization for an admin or owner. Joined to the client
  for its name.
- `PATCH /api/mcp/connections/{id}` sets the scope. Admin or owner only.
  Rejects anything above the organization ceiling. Bumps the epoch.
- `DELETE /api/mcp/connections/{id}` revokes. Own connection for a member, any
  for an admin or owner. Bumps the epoch.
- `PATCH /api/organizations/{id}/mcp-policy` sets the ceiling. Admin or owner.

Every one of these is authorized server side with the same helpers the rest of
settings uses, never on the client's say-so.

### Audit

Reuse `recordAuditEvent` with `resourceType: "mcp_connection"`:

- `mcp_connection.created` when a client completes consent
- `mcp_connection.scope_changed` with before and after
- `mcp_connection.revoked`

The scope string is not a secret, so it is safe in the diff under the existing
redaction contract. These land in the same audit trail the API keys section
already renders, so the activity panel gets connection history for free.

### UI

The Agents section becomes, top to bottom:

1. **Connections** table: client, who connected it, scope, connected, last
   used, status. Row actions: change scope for an admin, revoke for anyone
   who owns the row or administers the organization. Empty state explains how
   to connect one, which is what the section says today.
2. **Organization policy** card, admin and owner only: the maximum scope any
   connection may hold.
3. The existing **MCP endpoint** and **Client setup** cards, unchanged.
4. **Starter prompts**, unchanged.

Newly seen connections get a dot on the Agents nav item, on the same
`useNotificationStatus` pattern the avatar already uses for unread items.

## Build order

1. Epoch table, JWT claim, verifier check, cache. Nothing user visible, and it
   makes every later control real rather than decorative.
2. `last_used_at` and `revoked_at`, plus the audit events on connect.
3. Read-only connections table with the member and admin split.
4. Revoke.
5. Scope editing and the organization ceiling.

Steps one and two are safe to ship on their own and are worth landing first:
until the epoch exists, no button in this section can honestly claim to stop
anything.

## Open questions

- Should revoking a connection also notify the member by email? The owner
  alert path in `lib/security/audit-owner-alert.ts` already exists.
- Does a connection need a user supplied label, or is the client name plus
  connected date enough to tell two Claude Code connections apart?
- Should the organization ceiling apply retroactively, narrowing existing
  connections that exceed it, or only gate new consent and future edits?
