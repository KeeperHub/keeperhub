# Troubleshooting: from sign-up to your first execution

Every issue on this page was reproduced on a real onboarding run (macOS arm64, Homebrew, server `keeperhub v1.2.0`). Symptoms are listed verbatim so this page is searchable from the error you're staring at.

## `kh` prints nothing and dies (macOS)

**Symptom:** right after `brew install keeperhub/tap/kh`, any `kh` command is killed instantly — no output, exit code 137 (SIGKILL).

**Cause:** the Homebrew-installed binary carries the `com.apple.quarantine` attribute and macOS Gatekeeper kills the unsigned binary before it can print anything.

**Fix:**

```bash
xattr -d com.apple.quarantine "$(realpath "$(which kh)")"
kh version   # should print a version now
```

## `kh doctor` says authenticated AND "requires authentication"

**Symptom:** with a valid `KH_API_KEY`, `kh doctor` shows `Auth: authenticated` but also `[warn] Wallet: requires authentication` and `[warn] Spend Cap: requires authentication`.

**Cause:** the wallet and spend-cap checks use a browser OAuth session, not the org API key. Your key is fine.

**Fix:** run `kh auth login` if you need those two checks; for API/MCP usage you can ignore the warnings — execution works with the API key alone.

## MCP returns `{"error":"Invalid JSON body"}` but my JSON is valid

**Symptom:** raw HTTP (curl, hand-rolled client) against `/mcp` returns `Invalid JSON body` for requests that parse fine.

**Cause:** the Streamable-HTTP transport is session-based, and a missing/unknown session currently produces the same error as malformed JSON. A bare client must:

1. POST `initialize`;
2. read the **`Mcp-Session-Id` response header** (it is not in the body);
3. POST `notifications/initialized` with that header;
4. send the header on **every** subsequent request.

**Working smoke test:**

```bash
curl -si -X POST "$KH_API_URL/mcp" \
  -H "Authorization: Bearer $KH_API_KEY" \
  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"smoke","version":"1.0"}}}'
# note the Mcp-Session-Id response header; send it on every later request
```

Responses may arrive as Server-Sent Events — concatenate the `data:` lines before JSON-parsing.

## My execution "completed" but I have no transaction hash

**Symptom:** `execute_transfer` / `execute_contract_call` return `{executionId, status}` only — even when `status` is already `"completed"`.

**Fix:** call `get_direct_execution_status` with the `execution_id`; the terminal response carries `transactionHash` and `transactionLink`. Poll until the status is terminal before reporting success. (Use `get_execution` only for *workflow* executions — the two are different tools.)

Two adjacent gotchas:

- `function_args` and `abi` are JSON **strings**, not arrays/objects: `"[\"0x...\",\"0\"]"`.
- The status payload's `topLevelTo` is the relayer/entrypoint hop, **not** your wallet; the effective sender/owner is your wallet-integration address (`get_wallet_integration.walletAddress`).

## `409 idempotency_conflict` after a failed create

**Symptom:** a `create_workflow` that failed (e.g. `402 upgrade_required`) still reserved its `idempotency_key`; retrying a corrected payload under the same key returns 409.

**Fix:** rotate the idempotency key whenever you change the payload after a failure. Same key + same args within 24h replays the original result — that's the intended retry path.

## `402 upgrade_required` when adding a notification action

**Symptom:** `create_workflow` with `webhook/send-webhook`, `HTTP Request`, or `code/run-code` fails with `requiredPlan: pro`.

**Cause:** notification/compute actions are Pro-plan features; Web3 read/write actions are available on the free plan.

**Workaround on free:** wire your trigger to a `web3/read-contract` action (fully functional, executable, validatable) and add the notify leg after upgrading — the `create_workflow` call is otherwise identical.

## `503 "The workflow owner has disabled this workflow"` on a workflow you just listed

**Symptom:** `list_workflow` succeeded, but consumers calling the slug get a 503.

**Cause:** the workflow itself is `enabled: false`; listing does not check it.

**Fix:** `update_workflow` with `enabled: true`. Also note: `priceUsdcPerCall` must be a **string** (`"0.01"`), and changing the price while listed returns `409 PRICE_CHANGE_WHILE_LISTED` — unlist, set the price, re-list.
