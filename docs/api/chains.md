---
title: "Chains API"
description: "KeeperHub Chains API - list supported blockchain networks and fetch contract ABIs."
---

# Chains API

Access supported blockchain networks and contract information.

## List Chains

```http
GET /api/chains
```

Returns all supported blockchain networks. The catalog is public, so this
endpoint answers with or without a credential. To confirm an API key is valid,
call `GET /api/keys` instead. See
[Checking a key works](/api/authentication#checking-a-key-works).

### Query Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `includeDisabled` | boolean | Include disabled chains (default: false) |

### Response

Returns a bare JSON array of chain objects. The response is not wrapped in a `data` envelope.

```json
[
  {
    "id": "chain_1",
    "chainId": 1,
    "name": "Ethereum Mainnet",
    "symbol": "ETH",
    "chainType": "evm",
    "explorerUrl": "https://etherscan.io",
    "explorerAddressPath": "/address/",
    "explorerApiUrl": "https://api.etherscan.io",
    "explorerApiType": "etherscan",
    "isTestnet": false,
    "isEnabled": true,
    "usePrivateMempoolRpc": false
  },
  {
    "id": "chain_2",
    "chainId": 11155111,
    "name": "Sepolia",
    "symbol": "ETH",
    "chainType": "evm",
    "explorerUrl": "https://sepolia.etherscan.io",
    "explorerAddressPath": "/address/",
    "explorerApiUrl": "https://api-sepolia.etherscan.io",
    "explorerApiType": "etherscan",
    "isTestnet": true,
    "isEnabled": true,
    "usePrivateMempoolRpc": false
  }
]
```

### Response Fields

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Internal chain identifier |
| `chainId` | number | Numeric EVM chain ID (or Solana network ID) |
| `name` | string | Human-readable chain name |
| `symbol` | string | Native token symbol |
| `chainType` | string | `evm` or `solana` (see below) |
| `explorerUrl` | string \| null | Block explorer base URL |
| `explorerAddressPath` | string \| null | Path segment appended to `explorerUrl` for address links |
| `explorerApiUrl` | string \| null | Explorer API base URL for ABI / verification lookups |
| `explorerApiType` | string \| null | Explorer API family (e.g. `etherscan`, `blockscout`) |
| `isTestnet` | boolean | Whether this chain is a testnet |
| `isEnabled` | boolean | Whether the chain is currently available for workflow execution |
| `usePrivateMempoolRpc` | boolean | Whether this chain offers a configured private relay (Flashbots Protect): `true` only when the relay is switched on and its URL is set. This does not enable private routing by default. |

RPC endpoint URLs (`defaultPrimaryRpc`, `defaultFallbackRpc`) are not returned by this endpoint. They may embed provider API keys and are read server-side only; client code should use the user-configurable RPC preferences API instead.

### Private Mempool Capability

`usePrivateMempoolRpc` describes a chain capability, not the route used by a
specific transaction. A `true` value lists Private relay in the Send as field
of workflow write actions (see [Send as](/plugins/web3#send-as)). Choosing it
stores `sendMode: "private-relay"`, together with `usePrivateMempool: true` for
older readers; a save that sends `sendMode` alone gets `usePrivateMempool`
written beside it. Programmatic workflow definitions can send either key; a
config with `usePrivateMempool: true` and no `sendMode` sends through the relay
on a chain that has one and to the public mempool elsewhere (never sponsored),
as it always did. New values of `usePrivateMempool` must be booleans; an older
stored value that is not a boolean (such as the text `"false"`) is read the
same way. Any `sendMode` other
than `"transaction"` or `"private-relay"` is refused. When both keys are sent
they must agree (`true` with `"private-relay"`, `false` with `"transaction"`),
except on an update that changes only one of them: that key wins, and both are
saved in agreement. To change the route, set `sendMode`. Saving
`"private-relay"` on a chain where this value is `false` is refused.

Private routing is strict by default: when the private RPC is available, its
public fallback is removed, and a step with `sendMode: "private-relay"` on a
chain without a relay fails before anything is sent (for example a network set
by a template). Set
`strict: false` only when falling back to the public mempool is acceptable;
the send itself can then go to the public mempool. See
[Send as](/plugins/web3#send-as) for exactly when it falls back. A relay that
serves another chain is always refused, `strict: false` included. Saving a
workflow again is allowed while a step's network and Send as are unchanged.

Private-mempool writes are not gas sponsored because Turnkey sponsorship uses
its own broadcast path. The direct node-execution API takes `sendMode`,
`usePrivateMempool` and `strict` in a write action's config, runs the same
Send as checks as a workflow save, and answers 400 with the first problem
found. The contract-call and transfer execution endpoints and the MCP execute
tools take no `sendMode` and always send normally.

Neither this chain capability nor a saved workflow setting confirms that a
specific transaction used a private route. Workflow Write Contract and Batch
Write Contract steps report it in their `route` and `included` outputs; see
[Write Contract](/plugins/web3#write-contract).

### Chain Types

| Type | Description |
|------|-------------|
| `evm` | Ethereum Virtual Machine compatible |
| `solana` | Solana network |

## Chain Identifiers

KeeperHub action and execute endpoints accept either of two equivalent fields for selecting the target chain:

- `chainId` (canonical): the numeric chain ID. Send a number or a stringified number. Examples: `1`, `8453`, `11155111`.
- `network` (deprecated alias): same field, retained for backward compatibility. In addition to numeric chain IDs, it resolves the common chain names below.

Prefer `chainId` in new clients. Both fields produce identical behavior; passing both is treated as `chainId` winning.

### Accepted Chain Names

These string aliases are normalized to the numeric chain ID before routing. Names are case-insensitive.

| Name aliases | chainId | Network |
|---|---|---|
| `mainnet`, `ethereum`, `eth-mainnet`, `ethereum-mainnet` | 1 | Ethereum Mainnet |
| `sepolia`, `eth-sepolia`, `sepolia-testnet` | 11155111 | Ethereum Sepolia |
| `hoodi`, `eth-hoodi`, `hoodi-testnet` | 560048 | Ethereum Hoodi |
| `base`, `base-mainnet` | 8453 | Base |
| `base-sepolia`, `base-testnet` | 84532 | Base Sepolia |
| `tempo`, `tempo-mainnet` | 4217 | Tempo |
| `tempo-testnet` | 42431 | Tempo Testnet |
| `hyperevm`, `hyperevm-mainnet` | 999 | HyperEVM |
| `solana`, `solana-mainnet` | 101 | Solana |
| `solana-devnet`, `solana-testnet` | 103 | Solana Devnet |

Numeric chain IDs (as number or string) are accepted on every chain, including any chain present in `GET /api/chains` that does not appear in the alias table above.

## Fetch Contract ABI

```http
GET /api/chains/{chainId}/abi?address={contractAddress}
```

Fetches the ABI for a verified contract from the block explorer. The `{chainId}` path parameter is the numeric chain ID (e.g., `1`, `8453`, `11155111`), not a chain name and not the internal `id` field from `GET /api/chains`.

### Query Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `address` | string | Contract address (required) |

### Response

```json
{
  "success": true,
  "abi": [
    {
      "type": "function",
      "name": "balanceOf",
      "inputs": [{"name": "account", "type": "address"}],
      "outputs": [{"name": "", "type": "uint256"}]
    }
  ],
  "explorerUrl": "https://etherscan.io"
}
```
