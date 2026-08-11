# UAT v1: Minimal Viable HTTP MCP

## Version Scope

v1 covers the foundational HTTP MCP endpoint at `POST https://app.keeperhub.com/mcp`. This version validates protocol compliance with the MCP HTTP transport specification, authentication via `kh_` API keys, session management, tool listing, core workflow CRUD tools, read-only Web3 tools, error handling, and basic client integration with Claude Code and Cursor.

All tools are invoked through JSON-RPC `tools/call` requests over the HTTP transport. No SSE streaming, no OAuth, no write Web3 operations in this version.

---

## 1. Protocol Compliance

- [ ] **TC-01: Initialize handshake**
  - Precondition: Valid `kh_` API key available
  - Steps: Send `POST /mcp` with JSON-RPC `initialize` method containing `clientInfo` and `protocolVersion`
  - Expected: Response contains `serverInfo` with server name/version, `protocolVersion`, and `capabilities` object. HTTP 200.

- [ ] **TC-02: Mcp-Session-Id header returned on initialize**
  - Precondition: None
  - Steps: Send `initialize` request to `POST /mcp`
  - Expected: Response includes `Mcp-Session-Id` header with a unique session identifier string

- [ ] **TC-03: Subsequent requests require Mcp-Session-Id**
  - Precondition: Completed initialize handshake, have session ID
  - Steps: Send `tools/list` request without `Mcp-Session-Id` header
  - Expected: HTTP 400 or JSON-RPC error indicating missing session header

- [ ] **TC-04: Subsequent requests with valid Mcp-Session-Id succeed**
  - Precondition: Completed initialize handshake, have session ID
  - Steps: Send `tools/list` request with valid `Mcp-Session-Id` header
  - Expected: HTTP 200 with valid JSON-RPC response containing tool list

- [ ] **TC-05: JSON-RPC format validation**
  - Precondition: Valid session
  - Steps: Send request with missing `jsonrpc` field, missing `method` field, and invalid `id` type
  - Expected: Each returns JSON-RPC error with appropriate error code (-32600 Invalid Request)

- [ ] **TC-06: Content-Type negotiation**
  - Precondition: Valid session
  - Steps: Send request with `Content-Type: application/json`. Then send with `Content-Type: text/plain`
  - Expected: `application/json` accepted and processed. `text/plain` rejected with HTTP 415 or appropriate error.

- [ ] **TC-07: JSON-RPC batch requests**
  - Precondition: Valid session
  - Steps: Send a JSON-RPC batch array containing two valid `tools/call` requests
  - Expected: Response is a JSON-RPC batch array with two results, each matching the corresponding request ID

- [ ] **TC-08: JSON-RPC notification (no id field)**
  - Precondition: Valid session
  - Steps: Send a valid JSON-RPC request without an `id` field (notification)
  - Expected: Server processes the notification. No response body returned (or HTTP 204).

---

## 2. Authentication

- [ ] **TC-09: Valid kh_ API key accepted**
  - Precondition: Active `kh_` API key for an org
  - Steps: Send `initialize` with `Authorization: Bearer kh_abc123...`
  - Expected: HTTP 200, successful initialize response with session ID

- [ ] **TC-10: Invalid kh_ API key rejected**
  - Precondition: None
  - Steps: Send `initialize` with `Authorization: Bearer kh_invalid_garbage`
  - Expected: HTTP 401 Unauthorized with JSON-RPC error

- [ ] **TC-11: Expired kh_ API key rejected**
  - Precondition: A `kh_` key that has been revoked or expired
  - Steps: Send `initialize` with the expired key
  - Expected: HTTP 401 Unauthorized with JSON-RPC error

- [ ] **TC-12: Missing Authorization header**
  - Precondition: None
  - Steps: Send `initialize` without any `Authorization` header
  - Expected: HTTP 401 Unauthorized

- [ ] **TC-13: Wrong auth prefix rejected**
  - Precondition: None
  - Steps: Send `initialize` with `Authorization: Basic kh_abc123...`
  - Expected: HTTP 401 Unauthorized

- [ ] **TC-14: Key scoped to correct org**
  - Precondition: Two orgs (OrgA, OrgB) with separate API keys
  - Steps: Initialize with OrgA key. Call `workflow_list`.
  - Expected: Only OrgA workflows returned. No OrgB data leaks.

---

## 3. Session Management

- [ ] **TC-15: Session created on initialize**
  - Precondition: Valid API key
  - Steps: Send `initialize` request
  - Expected: `Mcp-Session-Id` header present in response. Session is usable for subsequent requests.

- [ ] **TC-16: Session reuse across multiple requests**
  - Precondition: Active session
  - Steps: Send `tools/list`, then `tools/call` for `workflow_list`, both with the same session ID
  - Expected: Both succeed. No need to re-initialize.

- [ ] **TC-17: Session timeout after 30 minutes of inactivity**
  - Precondition: Active session
  - Steps: Wait 30+ minutes without sending any request. Then send `tools/list` with the session ID.
  - Expected: HTTP 400 or JSON-RPC error indicating session expired/not found. Client must re-initialize.

- [ ] **TC-18: Session terminated via DELETE**
  - Precondition: Active session
  - Steps: Send `DELETE /mcp` with `Mcp-Session-Id` header
  - Expected: HTTP 200 or 204. Subsequent requests with that session ID fail.

- [ ] **TC-19: Max sessions per org enforced**
  - Precondition: Know the max sessions limit (e.g., 10)
  - Steps: Initialize sessions up to the limit + 1
  - Expected: The request exceeding the limit returns an error (HTTP 429 or JSON-RPC error indicating session limit reached)

- [ ] **TC-20: Stale session ID from different key rejected**
  - Precondition: Two valid API keys for same org
  - Steps: Initialize with KeyA, get SessionA. Send `tools/list` using KeyB but SessionA's ID.
  - Expected: Error. Session is bound to the key/auth that created it.

---

## 4. Tool Listing

- [ ] **TC-21: tools/list returns all registered tools**
  - Precondition: Active session
  - Steps: Send `tools/list` request
  - Expected: Response contains an array of tool objects. Each has `name`, `description`, and `inputSchema`.

- [ ] **TC-22: Workflow tools present in listing**
  - Precondition: Active session
  - Steps: Send `tools/list`, inspect tool names
  - Expected: Contains `workflow_list`, `workflow_get`, `workflow_create`, `workflow_update`, `workflow_delete`, `workflow_execute`, `execution_status`, `execution_logs`

- [ ] **TC-23: Web3 read tools present in listing**
  - Precondition: Active session
  - Steps: Send `tools/list`, inspect tool names
  - Expected: Contains `web3_check-balance`, `web3_read-contract`, `web3_check-token-balance`

- [ ] **TC-24: AI generation tool present**
  - Precondition: Active session
  - Steps: Send `tools/list`, inspect tool names
  - Expected: Contains `ai_generate_workflow` (or equivalent name)

- [ ] **TC-25: Schema listing tool present**
  - Precondition: Active session
  - Steps: Send `tools/list`, inspect tool names
  - Expected: Contains `list_action_schemas` (or equivalent name)

- [ ] **TC-26: Tool inputSchema is valid JSON Schema**
  - Precondition: Active session
  - Steps: Send `tools/list`. For each tool, validate `inputSchema` is a valid JSON Schema object with `type`, `properties`, and `required` fields where applicable.
  - Expected: All schemas pass JSON Schema validation

- [ ] **TC-27: tools/list with pagination cursor**
  - Precondition: Active session
  - Steps: Send `tools/list` with a `cursor` parameter if the tool count exceeds a page size
  - Expected: If pagination is supported, subsequent pages return remaining tools. If not paginated, all tools returned in one response.

---

## 5. Workflow Tools

- [ ] **TC-28: workflow_list returns org workflows**
  - Precondition: Active session, org has at least one workflow
  - Steps: Call `tools/call` with `name: "workflow_list"`
  - Expected: Response contains array of workflow summaries (id, name, status)

- [ ] **TC-29: workflow_get retrieves single workflow**
  - Precondition: Active session, known workflow ID
  - Steps: Call `tools/call` with `name: "workflow_get"`, `arguments: { "id": "<workflow-id>" }`
  - Expected: Response contains full workflow definition including trigger, steps, and configuration

- [ ] **TC-30: workflow_create creates a new workflow**
  - Precondition: Active session
  - Steps: Call `tools/call` with `name: "workflow_create"`, `arguments: { "name": "UAT Test Workflow", "trigger": { "type": "manual" }, "steps": [] }`
  - Expected: Response contains the created workflow with a new ID. Subsequent `workflow_list` includes it.

- [ ] **TC-31: workflow_update modifies an existing workflow**
  - Precondition: Active session, workflow created in TC-30
  - Steps: Call `tools/call` with `name: "workflow_update"`, `arguments: { "id": "<id>", "name": "UAT Test Workflow Updated" }`
  - Expected: Response confirms update. `workflow_get` reflects the new name.

- [ ] **TC-32: workflow_delete removes a workflow**
  - Precondition: Active session, workflow created in TC-30
  - Steps: Call `tools/call` with `name: "workflow_delete"`, `arguments: { "id": "<id>" }`
  - Expected: Response confirms deletion. `workflow_list` no longer includes it. `workflow_get` returns not found.

- [ ] **TC-33: workflow_execute triggers execution**
  - Precondition: Active session, a valid workflow with manual trigger
  - Steps: Call `tools/call` with `name: "workflow_execute"`, `arguments: { "id": "<workflow-id>" }`
  - Expected: Response contains an execution ID

- [ ] **TC-34: execution_status returns current state**
  - Precondition: Execution triggered in TC-33
  - Steps: Call `tools/call` with `name: "execution_status"`, `arguments: { "executionId": "<exec-id>" }`
  - Expected: Response contains status (pending, running, completed, or failed) and timestamps

- [ ] **TC-35: execution_logs returns step-level output**
  - Precondition: Execution completed in TC-33
  - Steps: Call `tools/call` with `name: "execution_logs"`, `arguments: { "executionId": "<exec-id>" }`
  - Expected: Response contains array of log entries with step IDs, statuses, outputs, and timestamps

- [ ] **TC-36: workflow_execute with invalid ID**
  - Precondition: Active session
  - Steps: Call `tools/call` with `name: "workflow_execute"`, `arguments: { "id": "nonexistent-id" }`
  - Expected: JSON-RPC error indicating workflow not found

- [ ] **TC-37: AI workflow generation**
  - Precondition: Active session
  - Steps: Call `tools/call` with `name: "ai_generate_workflow"`, `arguments: { "prompt": "Send me an email every day at 9am" }`
  - Expected: Response contains a generated workflow definition with appropriate trigger and steps

---

## 6. Web3 Read Tools

- [ ] **TC-38: check-balance returns native token balance**
  - Precondition: Active session, known wallet address, known chain
  - Steps: Call `tools/call` with `name: "web3_check-balance"`, `arguments: { "address": "0x...", "chain": "ethereum" }`
  - Expected: Response contains balance as a string (in wei or human-readable with decimals)

- [ ] **TC-39: read-contract calls a view function**
  - Precondition: Active session, known contract with a view function
  - Steps: Call `tools/call` with `name: "web3_read-contract"`, `arguments: { "address": "0x...", "chain": "ethereum", "functionName": "totalSupply", "abi": [...] }`
  - Expected: Response contains the return value from the contract call

- [ ] **TC-40: check-token-balance returns ERC20 balance**
  - Precondition: Active session, known wallet, known ERC20 token
  - Steps: Call `tools/call` with `name: "web3_check-token-balance"`, `arguments: { "walletAddress": "0x...", "tokenAddress": "0x...", "chain": "ethereum" }`
  - Expected: Response contains token balance with symbol and decimals

- [ ] **TC-41: Web3 read with invalid chain**
  - Precondition: Active session
  - Steps: Call `web3_check-balance` with `chain: "nonexistent-chain"`
  - Expected: JSON-RPC error indicating unsupported or invalid chain

- [ ] **TC-42: Web3 read with invalid address**
  - Precondition: Active session
  - Steps: Call `web3_check-balance` with `address: "not-an-address"`
  - Expected: JSON-RPC error indicating invalid address format

---

## 7. Error Handling

- [ ] **TC-43: Invalid tool name**
  - Precondition: Active session
  - Steps: Call `tools/call` with `name: "nonexistent_tool"`
  - Expected: JSON-RPC error with code -32602 or similar, message indicates tool not found

- [ ] **TC-44: Missing required parameters**
  - Precondition: Active session
  - Steps: Call `tools/call` with `name: "workflow_get"`, `arguments: {}` (missing required `id`)
  - Expected: JSON-RPC error indicating missing required parameter

- [ ] **TC-45: Malformed JSON-RPC body**
  - Precondition: Valid auth header
  - Steps: Send `POST /mcp` with body `{ "not": "valid jsonrpc" }`
  - Expected: JSON-RPC error with code -32600 (Invalid Request)

- [ ] **TC-46: Malformed JSON body**
  - Precondition: Valid auth header
  - Steps: Send `POST /mcp` with body `{broken json`
  - Expected: JSON-RPC error with code -32700 (Parse error)

- [ ] **TC-47: Rate limiting returns 429**
  - Precondition: Active session
  - Steps: Send rapid-fire requests exceeding the rate limit (e.g., 100 requests in 1 second)
  - Expected: HTTP 429 with `Retry-After` header. JSON-RPC error in body.

- [ ] **TC-48: Method not found**
  - Precondition: Active session
  - Steps: Send JSON-RPC request with `method: "nonexistent/method"`
  - Expected: JSON-RPC error with code -32601 (Method not found)

- [ ] **TC-49: Extra/unknown parameters handled gracefully**
  - Precondition: Active session
  - Steps: Call `tools/call` with `name: "workflow_list"`, `arguments: { "unknownParam": "value" }`
  - Expected: Either ignored gracefully or returns a clear validation error. No server crash.

---

## 8. Client Integration

- [ ] **TC-50: Configure in Claude Code via HTTP transport**
  - Precondition: Claude Code CLI installed, valid `kh_` API key
  - Steps: Run `claude mcp add keeperhub --transport http https://app.keeperhub.com/mcp --header "Authorization: Bearer kh_..."`. Then start a conversation and ask Claude to list workflows.
  - Expected: MCP server connects. `tools/list` populates tools. Claude can call `workflow_list` and return results.

- [ ] **TC-51: Configure in Cursor via mcp-remote**
  - Precondition: Cursor IDE installed, `mcp-remote` npm package, valid `kh_` API key
  - Steps: Add MCP config in Cursor settings pointing to `https://app.keeperhub.com/mcp` with Bearer auth header. Open Cursor and verify tools panel.
  - Expected: Tools appear in Cursor's MCP tool panel. Calling a tool (e.g., list workflows) returns data.

- [ ] **TC-52: Tools appear and execute end-to-end in Claude Code**
  - Precondition: Claude Code configured per TC-50
  - Steps: Ask Claude to "create a workflow called MCP Test that runs on a manual trigger, then list all workflows, then delete the MCP Test workflow"
  - Expected: Claude calls `workflow_create`, `workflow_list` (shows the new one), and `workflow_delete` in sequence. All succeed.

- [ ] **TC-53: Session persists across multiple Claude Code turns**
  - Precondition: Claude Code configured and connected
  - Steps: In one conversation, ask Claude to list workflows. Then in a follow-up message, ask for details on one.
  - Expected: Both requests succeed using the same MCP session. No re-initialization required between turns.

- [ ] **TC-54: Client handles server error gracefully**
  - Precondition: Claude Code configured and connected
  - Steps: Ask Claude to get a workflow with an obviously invalid ID
  - Expected: Claude receives the error from the MCP server and reports it to the user in natural language. No crash or hang.
