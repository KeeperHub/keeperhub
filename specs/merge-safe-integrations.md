# Spec: Merge Safe Plugin into Safe Protocol

## Problem

Two separate integrations register with label "Safe" in the workflow builder UI:

- `safe-wallet` protocol (type: `safe-wallet`) -- 6 on-chain read actions + event triggers
- `safe` plugin (type: `safe`) -- 1 off-chain API action (`get-pending-transactions`)

Radix Select does not support duplicate `value` props. Both register as `value="Safe"`, causing the second integration's actions to collide with the first. Result: "Get Modules Paginated" disappears from the action dropdown.

## Solution

Inject the `safe` plugin's `get-pending-transactions` action into the `safe-wallet` protocol plugin at registration time. The `safe` plugin continues to exist for credential management (API key) but registers with zero actions.

## Changes

### 1. `keeperhub/plugins/safe/index.ts`

- Import `getIntegration` from `@/plugins/registry`
- Find `safe-wallet` plugin via `getIntegration("safe-wallet")`
- Push `get-pending-transactions` action with `credentialIntegrationType: "safe"` so the connection picker uses the Safe API key
- Call `registerIntegration` on the `safe` plugin with `actions: []`

### 2. `keeperhub/plugins/safe/steps/get-pending-transactions.ts`

- Change `_integrationType` from `"safe"` to `"safe-wallet"` (line 295)
- Ensures `pnpm discover-plugins` generates `safe-wallet/get-pending-transactions` in the step registry

### 3. `plugins/legacy-mappings.ts`

- Add `"safe/get-pending-transactions": "safe-wallet/get-pending-transactions"`
- Existing workflows referencing the old ID continue to resolve in `findActionById`

### 4. `lib/workflow-executor.workflow.ts`

- After `getStepImporter(actionType)` returns undefined, check `LEGACY_ACTION_MAPPINGS`
- If found, retry with the mapped action type
- Ensures old workflows still execute after the step registry regeneration

### 5. `components/workflow/config/action-config.tsx`

- Filter `integrations` in the Service dropdown to exclude those with `actions.length === 0`
- Prevents the credential-only `safe` integration from appearing as a duplicate entry

### 6. `pnpm discover-plugins`

- Regenerates `lib/step-registry.ts` with `safe-wallet/get-pending-transactions`
- Regenerates `lib/types/integration.ts` (both types remain)

## Backward Compatibility

| Scenario | Action Type | Resolution |
|---|---|---|
| Old workflows | `safe/get-pending-transactions` | Legacy mapping in `findActionById` + executor fallback |
| New workflows | `safe-wallet/get-pending-transactions` | Direct step registry lookup |
| Safe credentials | type `safe` | Still registered, `credentialIntegrationType: "safe"` on injected action |

## Verification

1. Open "Module Installation Alert" workflow
2. Click "Read Modules" node -- one "Safe" entry in Service dropdown
3. Action dropdown shows all 7 actions including Get Modules Paginated and Get Pending Transactions
4. Select Get Pending Transactions -- connection picker shows Safe API key
5. Open "Safe Signing Alert" (uses old `safe/get-pending-transactions`) -- loads and executes correctly
6. `pnpm check && pnpm type-check` passes
