# UAT v2: Full Tool Coverage + SSE

## Version Scope

v2 builds on all v1 test cases (protocol compliance, authentication, session management, tool listing, workflow tools, read-only Web3, error handling, client integration). This version adds write Web3 operations with spending cap enforcement, protocol-specific plugin tools (Aave, Uniswap, Lido, Compound, Morpho, and others), Server-Sent Events (SSE) streaming via `GET /mcp`, and MCP resources for workflow data access.

**Prerequisites**: All v1 test cases (TC-01 through TC-54) pass before running v2 tests.

---

## 1. Write Web3 Tools

- [ ] **TC-55: transfer-funds sends native token**
  - Precondition: Active session, org wallet with test ETH on a testnet (e.g., Sepolia)
  - Steps: Call `tools/call` with `name: "web3_transfer-funds"`, `arguments: { "to": "0x...", "amount": "0.001", "chain": "sepolia" }`
  - Expected: Response contains transaction hash. Transaction confirms on-chain. Balance decreases accordingly.

- [ ] **TC-56: transfer-token sends ERC20 token**
  - Precondition: Active session, org wallet with test ERC20 tokens on testnet
  - Steps: Call `tools/call` with `name: "web3_transfer-token"`, `arguments: { "to": "0x...", "tokenAddress": "0x...", "amount": "10", "chain": "sepolia" }`
  - Expected: Response contains transaction hash. Token balance decreases for sender and increases for recipient.

- [ ] **TC-57: write-contract executes a state-changing function**
  - Precondition: Active session, known test contract with a write function on testnet
  - Steps: Call `tools/call` with `name: "web3_write-contract"`, `arguments: { "address": "0x...", "chain": "sepolia", "functionName": "approve", "abi": [...], "args": ["0xspender", "1000000"] }`
  - Expected: Response contains transaction hash. Contract state updated.

- [ ] **TC-58: Write operation requires wallet configured**
  - Precondition: Active session, org has no wallet configured
  - Steps: Call `web3_transfer-funds`
  - Expected: JSON-RPC error indicating no wallet available for the org/chain

- [ ] **TC-59: Write tool with insufficient balance**
  - Precondition: Active session, wallet with zero balance
  - Steps: Call `web3_transfer-funds` with `amount: "1000"`
  - Expected: JSON-RPC error indicating insufficient funds. No transaction submitted.

---

## 2. Spending Caps

- [ ] **TC-60: Transfer within spending cap succeeds**
  - Precondition: Active session, org spending cap set to 1 ETH per transaction
  - Steps: Call `web3_transfer-funds` with `amount: "0.5"` (under cap)
  - Expected: Transaction succeeds normally

- [ ] **TC-61: Transfer exceeding spending cap rejected**
  - Precondition: Active session, org spending cap set to 1 ETH per transaction
  - Steps: Call `web3_transfer-funds` with `amount: "2.0"` (over cap)
  - Expected: JSON-RPC error indicating spending cap exceeded. No transaction submitted.

- [ ] **TC-62: Token transfer respects token-specific cap**
  - Precondition: Active session, org has a USDC spending cap of 1000 USDC
  - Steps: Call `web3_transfer-token` with USDC amount of 1500
  - Expected: Rejected with spending cap error

- [ ] **TC-63: write-contract respects value spending cap**
  - Precondition: Active session, spending cap of 0.1 ETH
  - Steps: Call `web3_write-contract` with `value: "500000000000000000"` (0.5 ETH, over cap)
  - Expected: Rejected with spending cap error

- [ ] **TC-64: Cumulative spending cap tracked**
  - Precondition: Active session, org daily spending cap set to 2 ETH
  - Steps: Call `web3_transfer-funds` with `amount: "1.5"` (succeeds). Then call again with `amount: "1.0"` (cumulative 2.5 ETH, over daily cap).
  - Expected: First call succeeds. Second call rejected with daily spending cap error.

- [ ] **TC-65: Spending cap not applied to read operations**
  - Precondition: Active session, any spending cap configured
  - Steps: Call `web3_check-balance` and `web3_read-contract`
  - Expected: Both succeed without spending cap checks

---

## 3. Protocol Plugin Tools

### Aave

- [ ] **TC-66: Aave supply**
  - Precondition: Active session, wallet with test tokens, Aave deployment on testnet
  - Steps: Call `tools/call` with `name: "aave_supply"`, `arguments: { "asset": "0x...", "amount": "100", "chain": "sepolia" }`
  - Expected: Response contains transaction hash. Aave position reflects supplied amount.

- [ ] **TC-67: Aave borrow**
  - Precondition: Active session, existing Aave supply position as collateral
  - Steps: Call `tools/call` with `name: "aave_borrow"`, `arguments: { "asset": "0x...", "amount": "50", "chain": "sepolia", "interestRateMode": 2 }`
  - Expected: Response contains transaction hash. Borrowed tokens received.

- [ ] **TC-68: Aave repay**
  - Precondition: Active session, existing Aave borrow position
  - Steps: Call `tools/call` with `name: "aave_repay"`, `arguments: { "asset": "0x...", "amount": "25", "chain": "sepolia", "interestRateMode": 2 }`
  - Expected: Response contains transaction hash. Borrow balance decreases.

- [ ] **TC-69: Aave get-user-account-data (read)**
  - Precondition: Active session, wallet with Aave position
  - Steps: Call `tools/call` with `name: "aave_get-user-account-data"`, `arguments: { "address": "0x...", "chain": "sepolia" }`
  - Expected: Response contains total collateral, total debt, available borrow, LTV, health factor

### Uniswap

- [ ] **TC-70: Uniswap swap-exact-input**
  - Precondition: Active session, wallet with tokens, Uniswap pool exists on testnet
  - Steps: Call `tools/call` with `name: "uniswap_swap-exact-input"`, `arguments: { "tokenIn": "0x...", "tokenOut": "0x...", "amountIn": "100", "chain": "sepolia" }`
  - Expected: Response contains transaction hash. Input tokens spent, output tokens received.

- [ ] **TC-71: Uniswap quote-exact-input (read)**
  - Precondition: Active session
  - Steps: Call `tools/call` with `name: "uniswap_quote-exact-input"`, `arguments: { "tokenIn": "0x...", "tokenOut": "0x...", "amountIn": "100", "chain": "sepolia" }`
  - Expected: Response contains expected output amount without executing a transaction

- [ ] **TC-72: Uniswap get-pool (read)**
  - Precondition: Active session
  - Steps: Call `tools/call` with `name: "uniswap_get-pool"`, `arguments: { "tokenA": "0x...", "tokenB": "0x...", "fee": 3000, "chain": "ethereum" }`
  - Expected: Response contains pool address and liquidity info

### Lido

- [ ] **TC-73: Lido wrap stETH to wstETH**
  - Precondition: Active session, wallet with stETH
  - Steps: Call `tools/call` with `name: "lido_wrap"`, `arguments: { "amount": "1.0", "chain": "ethereum" }`
  - Expected: Response contains transaction hash. wstETH balance increases.

- [ ] **TC-74: Lido unwrap wstETH to stETH**
  - Precondition: Active session, wallet with wstETH
  - Steps: Call `tools/call` with `name: "lido_unwrap"`, `arguments: { "amount": "1.0", "chain": "ethereum" }`
  - Expected: Response contains transaction hash. stETH balance increases.

- [ ] **TC-75: Lido get-wsteth-balance (read)**
  - Precondition: Active session, known wallet
  - Steps: Call `tools/call` with `name: "lido_get-wsteth-balance"`, `arguments: { "address": "0x...", "chain": "ethereum" }`
  - Expected: Response contains wstETH balance

### Compound

- [ ] **TC-76: Compound supply**
  - Precondition: Active session, wallet with tokens, Compound market on testnet
  - Steps: Call `tools/call` with `name: "compound_supply"`, `arguments: { "asset": "0x...", "amount": "100", "chain": "sepolia" }`
  - Expected: Response contains transaction hash

- [ ] **TC-77: Compound get-balance (read)**
  - Precondition: Active session, address with Compound position
  - Steps: Call `tools/call` with `name: "compound_get-balance"`, `arguments: { "address": "0x...", "chain": "ethereum" }`
  - Expected: Response contains supply balance

- [ ] **TC-78: Compound withdraw**
  - Precondition: Active session, existing Compound supply position
  - Steps: Call `tools/call` with `name: "compound_withdraw"`, `arguments: { "asset": "0x...", "amount": "50", "chain": "sepolia" }`
  - Expected: Response contains transaction hash. Supply balance decreases.

### Morpho

- [ ] **TC-79: Morpho supply**
  - Precondition: Active session, wallet with tokens, valid Morpho market
  - Steps: Call `tools/call` with `name: "morpho_supply"`, `arguments: { "marketId": "0x...", "amount": "100", "chain": "ethereum" }`
  - Expected: Response contains transaction hash

- [ ] **TC-80: Morpho borrow**
  - Precondition: Active session, collateral supplied in Morpho
  - Steps: Call `tools/call` with `name: "morpho_borrow"`, `arguments: { "marketId": "0x...", "amount": "50", "chain": "ethereum" }`
  - Expected: Response contains transaction hash

- [ ] **TC-81: Morpho get-position (read)**
  - Precondition: Active session, address with Morpho position
  - Steps: Call `tools/call` with `name: "morpho_get-position"`, `arguments: { "marketId": "0x...", "address": "0x...", "chain": "ethereum" }`
  - Expected: Response contains supply shares, borrow shares, collateral amount

- [ ] **TC-82: Morpho vault-deposit**
  - Precondition: Active session, wallet with tokens, valid Morpho vault
  - Steps: Call `tools/call` with `name: "morpho_vault-deposit"`, `arguments: { "vault": "0x...", "amount": "100", "chain": "ethereum" }`
  - Expected: Response contains transaction hash

### Protocol tool write operations respect spending caps

- [ ] **TC-83: Protocol write tool respects spending cap**
  - Precondition: Active session, spending cap of 0.1 ETH
  - Steps: Call `aave_supply` with an amount that exceeds the cap in ETH value
  - Expected: Rejected with spending cap error

---

## 4. SSE Stream

- [ ] **TC-84: GET /mcp establishes SSE connection**
  - Precondition: Active session with valid `Mcp-Session-Id`
  - Steps: Send `GET /mcp` with `Accept: text/event-stream` and `Mcp-Session-Id` header
  - Expected: HTTP 200 with `Content-Type: text/event-stream`. Connection stays open.

- [ ] **TC-85: SSE receives execution progress notifications**
  - Precondition: SSE connection established, then trigger a workflow execution via POST
  - Steps: Call `workflow_execute` via POST. Monitor SSE stream.
  - Expected: SSE stream delivers progress events (e.g., step started, step completed) as `data:` lines with JSON payloads

- [ ] **TC-86: SSE event format compliance**
  - Precondition: SSE connection receiving events
  - Steps: Inspect raw SSE data
  - Expected: Each event has `id:` field, `event:` type, and `data:` JSON payload. Follows SSE specification.

- [ ] **TC-87: SSE connection closed on session DELETE**
  - Precondition: SSE connection active
  - Steps: Send `DELETE /mcp` with session ID
  - Expected: SSE connection closes cleanly

- [ ] **TC-88: SSE keepalive/ping events**
  - Precondition: SSE connection established, no activity
  - Steps: Wait and monitor SSE stream for 60 seconds
  - Expected: Server sends periodic keepalive/ping comments (`:` lines or ping events) to prevent connection timeout

- [ ] **TC-89: Multiple SSE connections to same session**
  - Precondition: Active session
  - Steps: Open two GET /mcp SSE connections with the same session ID
  - Expected: Either both receive events, or the second connection is rejected with an appropriate error (depending on design)

---

## 5. Resources

- [ ] **TC-90: List workflows resource**
  - Precondition: Active session, org has workflows
  - Steps: Send `resources/list` JSON-RPC request
  - Expected: Response includes `keeperhub://workflows` resource with name and description

- [ ] **TC-91: Read workflows list resource**
  - Precondition: Active session
  - Steps: Send `resources/read` with `uri: "keeperhub://workflows"`
  - Expected: Response contains a list of workflow summaries (ID, name, status) as resource content

- [ ] **TC-92: Read single workflow resource**
  - Precondition: Active session, known workflow ID
  - Steps: Send `resources/read` with `uri: "keeperhub://workflows/<workflow-id>"`
  - Expected: Response contains the full workflow definition as resource content

- [ ] **TC-93: Read nonexistent workflow resource**
  - Precondition: Active session
  - Steps: Send `resources/read` with `uri: "keeperhub://workflows/nonexistent-id"`
  - Expected: JSON-RPC error indicating resource not found

- [ ] **TC-94: Resource templates listed**
  - Precondition: Active session
  - Steps: Send `resources/templates/list` JSON-RPC request
  - Expected: Response includes `keeperhub://workflows/{id}` template with `uriTemplate` field

- [ ] **TC-95: Resources accessible from Claude Code**
  - Precondition: Claude Code configured with MCP server
  - Steps: Ask Claude to "read the workflow resource for workflow ID X"
  - Expected: Claude accesses the resource and displays the workflow details
