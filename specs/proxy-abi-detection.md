# Proxy Contract ABI Detection & Auto-Fetch

## Summary

When fetching an ABI for a contract address, automatically detect if it's a proxy contract and fetch the implementation ABI instead. Display an info banner to the user with the option to use the proxy ABI if needed.

## Background

Currently, when users fetch an ABI for a proxy contract, they get the proxy's ABI which lacks the actual function signatures. This causes issues when trying to interact with the contract. Users need the implementation ABI in nearly all cases.

## Implementation

**API Endpoint:**

```
https://api.etherscan.io/v2/api?chainid={CHAIN_ID}&module=contract&action=getsourcecode&address={CONTRACT_ADDRESS}&apikey={API_KEY}
```

**Response fields to check:**

- `Proxy` - "1" if proxy, "0" if not
- `Implementation` - implementation contract address (if proxy)

**Flow:**

1. User clicks "Fetch ABI"
2. Call `getsourcecode` for the entered address
3. If `Proxy === "1"` and `Implementation` exists:
   - Fetch ABI from the implementation address
   - Display info banner: "Proxy detected - using implementation ABI from `0x1234...`"
   - Show "Use proxy ABI instead" link/toggle
4. If not a proxy, proceed as normal

## Edge Cases

- **Unverified implementation**: Fall back to proxy ABI, show warning
- **Diamond proxy (multiple facets)**: Show warning that manual handling may be needed
- **User needs proxy ABI**: Provide toggle to switch

## Acceptance Criteria

- [ ] Proxy contracts are automatically detected via Etherscan API
- [ ] Implementation ABI is fetched by default for proxies
- [ ] Info banner displays when proxy is detected, showing implementation address
- [ ] User can toggle to use proxy ABI if needed
- [ ] Graceful fallback if implementation is unverified
