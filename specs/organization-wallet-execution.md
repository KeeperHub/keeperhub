# Organization Wallet Execution

## Overview

**Organization wallets are used during workflow execution**, enabling teams to collaborate on Web3 workflows without sharing private keys. Each organization has one wallet that all members can use for signing transactions.

**Key Principles:**
- Wallets are **organization-scoped**, not user-scoped
- All workflow executions use the **organization's wallet** (not the individual user's wallet)
- Only **admins/owners** can create/delete wallets
- All **members** can execute workflows that use the org wallet

This enables true team collaboration: any member can run workflows, but wallet management is restricted to admins.

---

## Current State (As of 2026-01-12)

### ✅ Implemented
- `lib/web3/wallet-helpers.ts` - Helpers use `organizationId`
- `keeperhub/api/user/wallet/route.ts` - API scoped by organization
- `keeperhub/components/overlays/wallet-overlay.tsx` - UI checks admin permissions
- Database schema includes `organization_wallets.organization_id` column

### ⚠️ Needs Update
- **Web3 plugin steps** still query by `userId` instead of `organizationId`
  - `keeperhub/plugins/web3/steps/transfer-funds.ts`
  - `keeperhub/plugins/web3/steps/write-contract.ts`
  - Any other steps that call `initializeWalletSigner()`

**Problem**: Steps currently do:
```typescript
// ❌ OLD: Gets userId, but wallets are now org-scoped
userId = await getUserIdFromExecution(_context.executionId);
signer = await initializeWalletSigner(userId, rpcUrl);
```

**Solution**: Steps should do:
```typescript
// ✅ NEW: Get organizationId instead
organizationId = await getOrganizationIdFromExecution(_context.executionId);
signer = await initializeWalletSigner(organizationId, rpcUrl);
```

---

## Execution Flow

### Data Chain
```
WorkflowExecution (has executionId)
    ↓
Workflow (has organizationId)
    ↓
Organization (has one Wallet)
    ↓
Wallet (used for signing)
```

### Lookup Pattern
1. **Step receives**: `_context.executionId` (automatically passed by workflow engine)
2. **Step queries**: `workflow_executions` table to get `workflowId`
3. **Step queries**: `workflows` table to get `organizationId`
4. **Step queries**: `organization_wallets` table to get wallet for org
5. **Step initializes**: Turnkey signer with org's wallet
6. **Step executes**: Transaction using org wallet

---

## Schema Reference

### workflow_executions
```typescript
{
  id: string,           // executionId (passed to steps via _context)
  workflowId: string,   // References workflows.id
  userId: string,       // User who triggered execution
  // ... status, input, output, etc.
}
```

### workflows
```typescript
{
  id: string,              // workflowId
  userId: string,          // Workflow creator
  organizationId: string,  // ⭐ Organization that owns workflow
  // ... nodes, edges, etc.
}
```

### organization_wallets
```typescript
{
  id: string,
  userId: string,          // Deprecated (migration in progress)
  organizationId: string,  // ⭐ Organization that owns wallet
  walletAddress: string,
  userShare: string,       // Encrypted keyshare
  // ...
}
```

**Note**: `workflows.organizationId` is the key link. It's already in the schema (see `lib/db/schema.ts:122`).

---

## Implementation Strategy

### Step 1: Add Helper Function

Create `getOrganizationIdFromExecution()` in a shared location (e.g., `lib/workflow-helpers.ts` or keep in each step file):

**Purpose**: Get organizationId from executionId by joining `workflow_executions` → `workflows`

**Returns**: `organizationId: string`

**Throws**: Error if execution not found or workflow has no organization

### Step 2: Update Plugin Steps

For each web3 step that uses `initializeWalletSigner()`:

1. Replace `getUserIdFromExecution()` with `getOrganizationIdFromExecution()`
2. Update variable names (userId → organizationId)
3. Update error messages ("user" → "organization")
4. Update logs to reflect organization context

### Step 3: Update Wallet Helpers (If Needed)

The `initializeWalletSigner()` function already supports organizationId since it calls `getOrganizationWallet()`. No changes needed to helper functions.

### Step 4: Handle Edge Cases

**Scenario: Organization has no wallet**
- Step should fail with clear error: "Organization does not have a wallet configured"
- User-facing message should guide them to create a wallet (admin permission required)

**Scenario: Execution has no organization**
- Should be impossible for authenticated users (auto-create ensures all users have an org)
- Anonymous workflows don't have org or wallet access (expected behavior)

**Scenario: User is not a member of the organization**
- Better-auth handles this at the API/session level
- Workflows are already scoped by organization, so user can't execute another org's workflows

---

## Migration Checklist for Plugin Steps

For each step file that uses wallet:

- [ ] Import/create `getOrganizationIdFromExecution()` helper
- [ ] Replace `getUserIdFromExecution()` call with `getOrganizationIdFromExecution()`
- [ ] Update variable name: `userId` → `organizationId`
- [ ] Update logs: "user:" → "organization:"
- [ ] Update error messages to reference "organization" instead of "user"
- [ ] Test execution with org wallet
- [ ] Verify error when org has no wallet

### Files to Update

- `keeperhub/plugins/web3/steps/transfer-funds.ts` (line 128)
- `keeperhub/plugins/web3/steps/write-contract.ts` (line 208)
- Any future web3 steps that need wallet access

---

## Testing Strategy

### 1. Happy Path - Org with Wallet
- Create organization
- Create wallet (as admin)
- Create workflow with web3 step (transfer/write-contract)
- Execute workflow
- **Expect**: Transaction succeeds using org wallet

### 2. Error Path - Org without Wallet
- Create organization (no wallet)
- Create workflow with web3 step
- Execute workflow
- **Expect**: Clear error message about missing wallet

### 3. Permission Test - Member Execution
- Sign in as org member (not admin)
- Execute existing workflow with web3 step
- **Expect**: Workflow runs successfully (uses org wallet)
- Try to create/delete wallet from UI
- **Expect**: UI shows "only admins can manage wallets"

### 4. Multi-Org Test
- User belongs to 2 organizations (Org A and Org B)
- Org A has wallet, Org B has wallet
- Execute workflow in Org A context
- **Expect**: Uses Org A's wallet
- Switch to Org B, execute workflow
- **Expect**: Uses Org B's wallet

### 5. Database Verification
After executing a workflow:
```sql
-- Get execution details
SELECT
  we.id AS execution_id,
  w.organization_id,
  pw.wallet_address,
  pw.organization_id AS wallet_org_id
FROM workflow_executions we
JOIN workflows w ON we.workflow_id = w.id
LEFT JOIN organization_wallets pw ON w.organization_id = pw.organization_id
WHERE we.id = '<execution_id>';

-- Verify wallet_org_id matches organization_id
```

---

## Error Messages

### Good Error Messages (User-Friendly)

**Org has no wallet:**
```
"Your organization does not have a wallet configured.
Please ask an admin to create one in Settings → Wallet."
```

**Wallet initialization failed:**
```
"Failed to initialize organization wallet: <technical error>
Please contact support or check your wallet configuration."
```

**Execution not found:**
```
"Workflow execution not found. Please try running the workflow again."
```

### Bad Error Messages (Avoid)

❌ "No wallet found for user"
❌ "User ID is required"
❌ "getUserWallet() failed"

These are confusing because wallets are org-scoped now, not user-scoped.

---

## Future Considerations

### 1. Multiple Wallets per Organization
Current: One wallet per organization
Future: Organization could have multiple wallets (e.g., treasury wallet, operations wallet)

**Required Changes:**
- Update schema: Remove unique constraint on `organization_wallets.organization_id`
- Add wallet selection UI in workflow step configuration
- Update `initializeWalletSigner()` to accept optional `walletId`

### 2. Wallet Permissions per Member
Current: All members can use org wallet
Future: Fine-grained permissions (e.g., only certain members can use wallet)

**Required Changes:**
- Add permission check in steps before initializing signer
- Update better-auth access control to include wallet usage permission
- UI to manage member wallet permissions

### 3. Audit Logging
Current: Execution logs show userId who triggered workflow
Future: Detailed audit trail of wallet usage

**Required Changes:**
- Log wallet address used per execution
- Track which transactions were signed by which org wallet
- Dashboard to view wallet transaction history

---

## Related Documentation

- [Organization Implementation](./organization-implementation.md) - Core org feature requirements
- [Organization Implementation Strategy](./organization-implementation-strategy.md) - Technical architecture
- [Organization Guard Implementation](./organization-guard-implementation.md) - Auto-create approach
- [Wallet Migration TODO](./wallet-migration-todo.md) - Database migration guide

---

## Contact

**Last Updated**: 2026-01-12
**Status**: Implementation guide - steps need updating
**Branch**: `feature/KEEP-1141-organizations`
