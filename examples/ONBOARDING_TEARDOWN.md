# KeeperHub Onboarding Teardown

**Bounty submission for: Best Onchain UX Improvement ($1,000)**

## What I Built

[KeeperPilot](https://github.com/ubongn/keeperpilot) — an autonomous onchain rebalancing agent that reads portfolio state via KeeperHub, decides on trades, and executes them through Direct Execution. Deployed to [Render](https://keeperpilot.onrender.com/) with a live dashboard, audit trail, and 60-second agent loop.

## Where I Got Stuck (and How to Fix It)

### 1. Contract-Call API Field Names

**Problem:** The docs show `functionName` and `functionArgs`, but the actual API accepts `abiFunction` and `args` as well. The field names are inconsistent between the docs and the API response format.

**What I tried:**
```json
{
  "functionName": "balanceOf",
  "functionArgs": "[\"0x...\"]"
}
```

**What actually works:**
```json
{
  "functionName": "balanceOf",
  "functionArgs": "[\"0x...\"]"
}
```

**But the response format is confusing:**
- Read (simulate:true): `{ "result": "1500000000000000000" }`
- Write: `{ "executionId": "xxx", "status": "pending" }`

**Proposed fix:** Add a clear "Response Format" section to the contract-call docs with examples for both read and write operations.

### 2. No Direct "Get Balance" Endpoint

**Problem:** To read ETH balance, there's no `GET /api/wallet/balance` endpoint. I had to:
1. Use `contract-call` with `simulate: true` for USDC (works)
2. For ETH, probe with a simulated transfer and parse the error message for "Have: X"

**The error message hack:**
```typescript
// This is how I read ETH balance — by parsing an error message
try {
  await client.transfer({ amount: '1000', simulate: true });
} catch (e) {
  const match = e.message.match(/Have:\s*([\d.]+)/);
  return match?.[1] || '0';
}
```

**Proposed fix:** Add `GET /api/wallet/balance?chainId=11155111` that returns `{ eth: "0.05", usdc: "20.0" }`.

### 3. USDC Contract-Call ABI Format

**Problem:** The ABI format for contract calls was confusing. The docs show:
```json
{ "abi": "[{\"type\":\"function\",...}]" }
```

But I had to figure out:
1. The ABI should be a JSON string, not an object
2. `functionArgs` must be a JSON string: `JSON.stringify([address])`
3. For `balanceOf`, the args are `[walletAddress]`
4. For `decimals`, the args are `[]`

**Proposed fix:** Add a "Common Patterns" section with copy-paste examples for:
- ERC-20 balanceOf
- ERC-20 decimals
- ERC-20 transfer
- Native ETH transfer

### 4. Polling UX

**Problem:** The `X-Poll-Interval-Hint` header is great, but:
- There's no max timeout documented
- The `running` status can last forever (no ETA)
- No WebSocket/SSE option for real-time updates

**Proposed fix:**
- Document the max poll timeout
- Add a `estimatedCompletionTime` field to the status response
- Consider SSE endpoint for live updates

### 5. Error Messages Could Be Clearer

**Problem:** Some errors are cryptic:
- `"Missing required field"` — which field?
- `"Execution failed"` — why? What was the revert reason?

**Proposed fix:**
- Include the missing field name in the error
- Always include the revert reason for failed transactions
- Add error codes (like Stripe) for programmatic handling

### 6. No Starter Template

**Problem:** I had to build everything from scratch. No `npx create-keeperhub-app` or starter template.

**What I built instead:** A complete Direct Execution client with:
- Idempotency keys
- Exponential backoff
- Poll with X-Poll-Interval-Hint
- Typed errors

**Proposed fix:** Add `examples/keeperhub-starter/` with a minimal, copy-paste project.

## What I'm Contributing

### 1. Starter Template (`examples/keeperhub-starter/`)

A minimal project that gets you from zero to first transaction in 5 minutes:
- `src/index.ts` — read → simulate → execute → confirm
- `.env.example` — configuration template
- `README.md` — quick start guide

### 2. Documentation Improvements

This teardown document with:
- Real issues found during hackathon
- Concrete proposed fixes
- Copy-paste examples

## Stats

- **Time to first successful transaction:** ~2 hours (should be 5 minutes)
- **API calls to figure out the right format:** ~50 (should be 5)
- **StackOverflow/GitHub issues searched:** ~20 (should be 0)

## Conclusion

KeeperHub is powerful but the onboarding friction is real. The API works great once you figure it out, but the path from "I have an API key" to "I have a transaction hash" has too many undocumented gotchas. These fixes would cut the onboarding time from 2 hours to 5 minutes for the next builder.
