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

Returns all supported blockchain networks.

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
| `usePrivateMempoolRpc` | boolean | Whether KeeperHub routes transactions through a private mempool (Flashbots Protect) by default |

RPC endpoint URLs (`defaultPrimaryRpc`, `defaultFallbackRpc`) are not returned by this endpoint. They may embed provider API keys and are read server-side only; client code should use the user-configurable RPC preferences API instead.

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
| `base`, `base-mainnet` | 8453 | Base |
| `base-sepolia`, `base-testnet` | 84532 | Base Sepolia |
| `tempo`, `tempo-mainnet` | 4217 | Tempo |
| `tempo-testnet` | 42431 | Tempo Testnet |
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

