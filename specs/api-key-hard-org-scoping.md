# API Key Hard Org-Scoping

Remove the `X-Organization-Id` header override mechanism. API keys become hard-scoped to their creation org, matching OAuth token behavior.

## Problem

API keys (`kh_` prefix) and OAuth tokens have inconsistent org-scoping:

| | OAuth | API Key |
|---|---|---|
| Org binding | Hard-scoped via JWT `org` claim | Soft-scoped via DB row, overridable |
| Cross-org access | Impossible (signed JWT) | Possible via `X-Organization-Id` header |
| Membership check | None needed (immutable claim) | DB lookup on `member` table per override request |
| Key leak blast radius | Single org | All orgs the key creator belongs to |

The `X-Organization-Id` header allows any `kh_` API key to access resources in any org its creator is a member of. This was a convenience feature for multi-org users but creates an unnecessary attack surface.

## Solution

Hard-scope API keys to their native org. Remove `X-Organization-Id` processing from the server. API keys and OAuth tokens then have identical security properties: one credential, one org.

### Server Changes (this PR)

**`lib/middleware/auth-helpers.ts`**

- Delete `resolveOrganizationOverride` function (lines 183-218)
- Remove `member` table import and `and`/`eq` from drizzle-orm (dead code after deletion)
- Simplify `resolveApiKeyContext`: return the key's native org directly
- Simplify `resolveOrganizationId`: return the key's org directly, no override check
- Simplify `resolveCreatorContext`: return the key's org directly, no override check
- Update JSDoc on `getDualAuthContext` to mention OAuth as a third auth method

**`lib/mcp/tools.ts`**

- Remove `organizationId` parameter from `callApi` function
- Remove `X-Organization-Id` header injection from `callApi`
- Remove `organizationId` from all static tool schemas (list_workflows, get_workflow, create_workflow, update_workflow, delete_workflow, execute_workflow, list_integrations, get_wallet_integration)
- Remove `organizationId` from dynamic tool schema in `registerDynamicTools`
- Clean up tool handlers that destructured `organizationId` from args

**`tests/unit/dual-auth-context.test.ts`**

- Add `authMethod` to all existing assertions (currently missing, causes test failures)
- Add test: API key with `X-Organization-Id` header gets the key's native org (not the override)
- Add test: OAuth returns authMethod "oauth"

### CLI Changes (separate PR -- cli repo)

**`cmd/serve/tools.go`**
- Remove `organizationId` from tool input schemas
- Remove `X-Organization-Id` header injection from tool handlers

**`internal/http/client.go`**
- Remove `orgOverride` field and `X-Organization-Id` header injection from `Client.Do()`

**`internal/config/hosts.go`** -- per-org token support
- Change `HostConfig` to support per-org tokens:
  ```yaml
  hosts:
    app.keeperhub.com:
      orgs:
        org_abc: { token: "kh_..." }
        org_xyz: { token: "kh_..." }
      default_org: org_abc
      # Legacy flat token still supported for migration
      token: "kh_..."
  ```
- `ResolveToken(host)` reads the active org's token from the `orgs` map, falling back to the flat `token` field

**`cmd/org/switch.go`**
- Update to select the active org's token locally (no longer just a server-side session mutation)

**`cmd/kh/main.go`**
- Wire `--org` flag to select token from `orgs` map instead of injecting `X-Organization-Id`
- Wire `DefaultOrg` from `config.yml` as fallback (currently defined but unused)

### MCP Schemas Endpoint

No changes needed. The `/api/mcp/schemas` endpoint describes plugin capabilities; it does not reference `X-Organization-Id`.

## Breaking Changes

| Who | What breaks | Migration |
|---|---|---|
| CLI users with `--org` flag | Flag no longer overrides org on API key requests | Create a `kh_` key per org; use per-org token config in `hosts.yml` |
| MCP clients passing `organizationId` tool arg | Parameter removed from tool schemas | Connect with an API key scoped to the target org |
| Direct API consumers using `X-Organization-Id` header | Header is ignored | Use an API key created in the target org |

## Security Properties After Change

- API key leak: attacker can only access the single org the key was created in
- OAuth token leak: attacker can only access the single org from the JWT claim
- Session cookie: org determined by server-side active org (unchanged)
- No cross-org access path exists for any credential type
