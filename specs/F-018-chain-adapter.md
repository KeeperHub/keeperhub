# F-018: ChainAdapter Interface

## Overview

Polymorphic chain abstraction layer that decouples workflow step execution logic from chain-specific transaction mechanics. Steps interact with a `ChainAdapter` interface rather than calling ethers.js, gas strategy, nonce manager, and explorer APIs directly.

## Architecture

```
Step (transfer-funds-core.ts)
  |
  +-- getChainAdapter(chainId)  -->  ChainAdapterRegistry
  |                                    |
  |                              isSolanaChain?
  |                              /            \
  |                    EvmChainAdapter    SolanaChainAdapter (stub)
  |                         |
  +-- adapter.sendTransaction(signer, request, session, options)
  |       |
  |       +-- gasStrategy.getGasConfig()     (injected)
  |       +-- nonceManager.getNextNonce()    (injected)
  |       +-- signer.sendTransaction()
  |       +-- nonceManager.recordTransaction()
  |       +-- tx.wait()
  |       +-- nonceManager.confirmTransaction()
  |
  +-- adapter.getTransactionUrl(hash)
          |
          +-- explorerConfigs DB query (cached)
```

## Interface

```typescript
interface ChainAdapter {
  readonly chainFamily: string;

  // Write operations
  sendTransaction(signer, request, session, options): Promise<TransactionReceipt>;
  executeContractCall(signer, request, session, options): Promise<TransactionReceipt>;

  // Read operations
  readContract(rpcManager, request): Promise<unknown>;
  getBalance(rpcManager, address): Promise<bigint>;
  executeWithFailover<T>(rpcManager, operation): Promise<T>;

  // Explorer
  getTransactionUrl(txHash): Promise<string>;
  getAddressUrl(address): Promise<string>;
}
```

## Design Decisions

### 1. Signer passed as parameter, not owned by adapter

The adapter does not manage wallet lifecycle. `initializeParaSigner()` is called by the step and the resulting signer is passed to the adapter. This keeps wallet management (Para-specific, org-level) orthogonal to chain operations.

### 2. Gas strategy and nonce manager injected via constructor

`AdaptiveGasStrategy` and `NonceManager` are injected into `EvmChainAdapter` as constructor dependencies. They are not merged into the adapter class. This preserves their existing singleton lifecycle and allows independent testing.

### 3. withNonceSession() stays in the step

The nonce session lifecycle (lock acquisition, session start/end) remains in the step via `withNonceSession()`. The adapter operates within an active session -- it calls `getNextNonce()` and `recordTransaction()` but does not own the session boundary.

### 4. Read operations accept rpcManager as parameter

Read methods take `RpcProviderManager` as a parameter rather than owning it internally. This is because the adapter is cached per chainId (in the registry), but RPC providers vary per user (due to user RPC preferences resolved by `getRpcProvider({ chainId, userId })`). Passing rpcManager avoids coupling the adapter cache to user-specific state.

### 5. Explorer config cached per adapter instance

`getExplorerConfig()` queries the DB once and caches the result. Since the adapter is cached per chainId and explorer config is immutable per chain, this eliminates redundant DB queries across multiple `getTransactionUrl()`/`getAddressUrl()` calls within the same process.

### 6. Protocol registry chainTypeFilter left as-is

The protocol registry hardcodes `chainTypeFilter: "evm"` for all protocol actions. This is intentionally not changed in F-018 because:
- No protocols currently support Solana
- The Solana adapter is a stub with no real implementation
- Making this dynamic adds complexity with no immediate consumer
- When F-019 (Solana implementation) lands, the protocol registry can be updated to read `chainType` from the protocol's supported chains

## Files

| File | Role |
|------|------|
| `lib/web3/chain-adapter/types.ts` | Interface and supporting types |
| `lib/web3/chain-adapter/evm.ts` | EVM implementation |
| `lib/web3/chain-adapter/solana.ts` | Solana stub |
| `lib/web3/chain-adapter/registry.ts` | Factory with caching |
| `lib/web3/chain-adapter/index.ts` | Barrel exports |

## Refactored Steps

| Step | Adapter Methods Used |
|------|---------------------|
| `transfer-funds-core.ts` | `sendTransaction`, `getTransactionUrl` |
| `write-contract-core.ts` | `executeContractCall`, `getTransactionUrl` |
| `transfer-token-core.ts` | `executeContractCall`, `getTransactionUrl` |
| `approve-token-core.ts` | `executeContractCall`, `getTransactionUrl` |
| `read-contract-core.ts` | `readContract`, `getAddressUrl` |
| `check-balance.ts` | `getBalance`, `getAddressUrl` |
| `check-token-balance.ts` | `executeWithFailover`, `getAddressUrl` |
| `check-allowance.ts` | `executeWithFailover` |

## Not Refactored (out of scope)

These steps use deeply EVM-specific patterns (Multicall3, queryFilter, explorer APIs) that don't map to a chain-agnostic interface:

- `batch-read-contract.ts` -- Multicall3 aggregation
- `query-events.ts` -- EVM event log queries with block range batching
- `query-transactions-core.ts` -- Explorer API transaction history
- `get-transaction.ts` -- Single transaction fetch by hash

These can adopt `adapter.executeWithFailover()` incrementally if needed.

## Future Work

- **F-019**: Implement `SolanaChainAdapter` with real Solana transaction support
- **F-021**: L2-specific optimizations can be per-chain adapter config
- **F-023**: Cross-chain orchestration builds on top of the adapter registry
- Protocol registry `chainTypeFilter` should become dynamic when Solana protocols exist
