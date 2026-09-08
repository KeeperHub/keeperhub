---
title: "Validate Workflow"
description: "Use the validate_workflow MCP tool to check a workflow's structural, listing-eligibility, and Web3-specific correctness before creation or publication."
---

# validate_workflow

`validate_workflow` checks a stored workflow for structural correctness, marketplace listing eligibility, and Web3-specific configuration problems before you call `create_workflow` or list the workflow on the marketplace. It returns typed error and warning items with precise parameter paths, designed for automated recovery loops.

The tool runs two tiers of checks. The fast tier (default) makes zero network calls and finishes in under 300 ms. The deep tier (`deepCheck: true`) additionally resolves on-chain ABIs for every contract reference and compares them against the declared ABIs, adding up to 3 seconds of latency.

## When to use

- **Before publishing to the marketplace** to catch missing `inputSchema`, broken `outputMapping` references, or an incorrect `workflowType`.
- **After `ai_generate_workflow`** to verify the generated structure is sound before enabling the workflow.
- **Inside an agent recovery loop**: generate a workflow, call `validate_workflow`, inspect the error codes, apply targeted fixes, and repeat until `valid` is `true`.
- **Before calling `execute_workflow`** when you want confidence that trigger config and node references are intact.

## Tool call

```json
{
  "tool": "validate_workflow",
  "arguments": {
    "workflowId": "wf_abc123"
  }
}
```

With `deepCheck`:

```json
{
  "tool": "validate_workflow",
  "arguments": {
    "workflowId": "wf_abc123",
    "deepCheck": true
  }
}
```

### Arguments

| Argument | Type | Required | Description |
|----------|------|----------|-------------|
| `workflowId` | string | Yes | The workflow's ID. Must belong to the caller's organization. |
| `deepCheck` | boolean | No (default `false`) | When `true`, also runs best-effort ABI bytecode matching against every contract reference. Adds up to 3 seconds. Emits warnings only — never errors — so proxy contracts never cause false positives. |

## Return shape

The result always contains `valid` (boolean) and `nodeCount` (number). The `errors` and `warnings` keys are **absent** when empty — they are never present as empty arrays.

### Valid workflow (no issues)

```json
{
  "ok": true,
  "result": {
    "valid": true,
    "nodeCount": 5
  }
}
```

### Workflow with errors

When `valid` is `false`, one or more `errors` entries are present. Each entry carries a stable `code`, a human-readable `message`, and a `parameterPath` that locates the offending field.

```json
{
  "ok": true,
  "result": {
    "valid": false,
    "nodeCount": 4,
    "errors": [
      {
        "code": "missing-input-schema-on-listed",
        "message": "Listed workflow has null inputSchema. Set inputSchema to a JSON Schema object.",
        "parameterPath": "inputSchema"
      }
    ]
  }
}
```

### Workflow with warnings (no errors)

Warnings do not affect `valid`. The workflow can be executed and listed even when warnings are present.

```json
{
  "ok": true,
  "result": {
    "valid": true,
    "nodeCount": 3,
    "warnings": [
      {
        "code": "low-confidence-abi-match",
        "message": "nodes[1].config.abi does not match the resolved ABI for 0x...",
        "parameterPath": "nodes[1].config.abi"
      }
    ]
  }
}
```

### parameterPath format

`parameterPath` is a dot-path string an agent can use to locate the offending field:

| Example | Meaning |
|---------|---------|
| `nodes` | Problem applies to the nodes array as a whole |
| `nodes[2].config.contractAddress` | Third node's contract address field |
| `outputMapping.result` | The `result` key in the workflow's output mapping |
| `inputSchema` | The workflow-level `inputSchema` field |
| `workflowType` | The `workflowType` field |

## Error code reference

All error codes are stable kebab-case identifiers. When any error is present, `valid` is `false`.

| Code | When emitted | Example fix |
|------|--------------|-------------|
| `empty-nodes-array` | The workflow has no nodes at all | Add at least a trigger node before saving |
| `unknown-edge-reference` | An edge's `source` or `target` references a node ID not present in `nodes` | Remove the orphaned edge, or add the missing node |
| `missing-trigger-config` | No node has `type: "trigger"` | Add a trigger node — Manual, Schedule, Webhook, or on-chain Event |
| `bare-at-literal-in-template` | A node config contains a bare `@nodeId` reference outside a `{{...}}` wrapper | Wrap the reference: `{{@nodeId:NodeLabel.field}}` |
| `missing-input-schema-on-listed` | The workflow has `isListed: true` but `inputSchema` is `null` | Set `inputSchema` to a JSON Schema object; an empty `{"type":"object"}` is valid for zero-input workflows |
| `unknown-output-mapping-node` | An `outputMapping` entry references a node ID not present in `nodes` | Update the mapping to a real node ID, or remove the stale entry |
| `missing-write-action-for-write-workflow` | `workflowType` is `"write"` but no node is a write action (`write-contract` or a protocol-write step) | Add a write-action node, or change `workflowType` to `"read"` |
| `unknown-chain-id` | A node's `network` field is a chain ID not enabled on the platform | Use a supported chain ID — call `list_action_schemas?includeChains=true` to see the full list |
| `invalid-token-address` | A `contractAddress` or `tokenConfig.customToken.address` fails the EVM address format check | Use a valid `0x`-prefixed 40-hex-character address |

## Warning code reference

Warnings do not set `valid: false`. They indicate something worth reviewing, but the workflow can still be executed or listed.

| Code | When emitted | When safe to ignore |
|------|--------------|---------------------|
| `write-action-on-read-workflow` | `workflowType` is `"read"` but the workflow contains a write-action node | When the classification is intentional (for example, a simulate-then-read pattern) |
| `low-confidence-abi-match` | (`deepCheck` only) The declared ABI's function signatures do not match those resolved from the contract's on-chain bytecode | Always safe to ignore for proxy contracts — Aave V3 Pool, Uniswap V3, WETH, and any EIP-1967 / EIP-1822 / EIP-2535 proxy. The platform's runtime ABI resolver handles proxies automatically; a deep-check mismatch here is informational only |
| `missing-allowance-preflight` | A `write-contract` node calls an allowance-consuming method (`transferFrom`, `redeem`, `withdrawFrom`) without a preceding Check Allowance node | When the spender already has sufficient allowance, or allowance is granted outside this workflow |

## deepCheck semantics

### Fast tier (default)

The default `deepCheck: false` tier makes zero network calls. It covers:

- Structural validity (nodes, edges, trigger presence)
- Template expression syntax (`{{@nodeId:Label.field}}` pattern)
- Marketplace listing eligibility (`inputSchema`, `outputMapping` references)
- Write-action / workflow-type consistency
- Chain ID existence (database lookup, cached per request)
- Token address format (synchronous `isAddress()` check)

Expected latency: under 300 ms at the 95th percentile.

### Deep tier

When `deepCheck: true`, the validator additionally attempts to resolve the actual on-chain ABI for every contract reference and compares function signature sets against the declared ABI. Mismatches emit `low-confidence-abi-match` warnings — never errors.

This handles proxy contracts (EIP-1967, EIP-1822, EIP-2535) gracefully. The platform's runtime ABI resolver already handles proxy delegation; the deep tier does not replicate that logic, so a mismatch on a proxy is expected and carries no operational risk. Aave V3 Pool, Uniswap V3, and WETH are the most common proxies that produce this warning — it is safe to ignore in all three cases.

Latency budget for `deepCheck: true`:

- Per-contract ABI lookup capped at 2 seconds
- Total deep-check duration capped at 3 seconds
- At most 5 ABI lookups run concurrently
- If an explorer endpoint is degraded, the missing lookup is silently skipped — no warning, no error

**Do not loop `deepCheck: true` calls tighter than once every few seconds.** Use the fast tier for tight generate-validate-fix loops; reserve `deepCheck: true` for final pre-publication review.

## Examples

### Example 1 — fast-tier recovery loop

An agent generates a workflow and immediately validates it:

Tool call:
```json
{
  "tool": "validate_workflow",
  "arguments": {
    "workflowId": "wf_abc123"
  }
}
```

Response:
```json
{
  "ok": true,
  "result": {
    "valid": false,
    "nodeCount": 4,
    "errors": [
      {
        "code": "missing-input-schema-on-listed",
        "message": "Listed workflow has null inputSchema. Set inputSchema to a valid JSON Schema object.",
        "parameterPath": "inputSchema"
      },
      {
        "code": "unknown-output-mapping-node",
        "message": "outputMapping references node 'result-node' which does not exist in nodes.",
        "parameterPath": "outputMapping.result"
      }
    ]
  }
}
```

The agent reads the `errors` array, patches `inputSchema` and fixes the `outputMapping` reference, calls `update_workflow`, then calls `validate_workflow` again. When the response comes back with `valid: true` and no `errors` key, the loop is complete.

### Example 2 — deep-check validation on a proxy-contract workflow

A workflow calls the Aave V3 Pool contract. The agent runs `deepCheck: true` before listing:

Tool call:
```json
{
  "tool": "validate_workflow",
  "arguments": {
    "workflowId": "wf_uniswap_rebalancer",
    "deepCheck": true
  }
}
```

Response:
```json
{
  "ok": true,
  "result": {
    "valid": true,
    "nodeCount": 3,
    "warnings": [
      {
        "code": "low-confidence-abi-match",
        "message": "nodes[1].config.abi signature set does not match resolved ABI for 0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2. Proxy contracts are expected to mismatch (informational warning only).",
        "parameterPath": "nodes[1].config.abi"
      }
    ]
  }
}
```

`valid` is `true`. The `low-confidence-abi-match` warning for the Aave V3 Pool proxy is expected — the platform's runtime resolver already handles EIP-1967 delegation at execution time. The workflow is ready to list.

### Example 3 — clean fast-tier pass

```json
{
  "ok": true,
  "result": {
    "valid": true,
    "nodeCount": 2
  }
}
```

Both `errors` and `warnings` are absent because neither collection has entries. An agent can check `result.valid === true && !result.errors` to confirm a clean state.

## Authorization

`validate_workflow` is a read-scoped tool. It is available to any connection that can call `list_workflows` — OAuth or API key, same organization scoping rules apply. The workflow must belong to the caller's organization.

| HTTP status | Meaning |
|-------------|---------|
| `200` | Validation completed (regardless of `valid: true` or `valid: false`) |
| `403` | Caller is not authorized for this organization or workflow |
| `404` | Workflow ID not found |
| `410` | Workflow has been deleted |

## Limitations

- `validate_workflow` operates on workflows already stored in the platform. To validate freshly generated JSON before persisting it, call `create_workflow` first (which performs its own structural checks), then validate the stored result.
- The deep tier's ABI check is signature-set based. It confirms the declared ABI's function selectors match the contract's resolved ABI, but does not cross-validate argument types, return types, or revert semantics.
- Token decimals and `symbol()` resolution are not included.
- Chain ID existence is checked against the platform's enabled chains at the time of the call. A chain enabled today may not have been enabled when the workflow was created — the check reflects current state.
