---
title: "Chronicle"
description: "Decentralized, verifiable oracle price feeds with Schnorr signature verification on Ethereum and Sepolia."
---

# Chronicle

Chronicle Protocol publishes decentralized, verifiable oracle price feeds secured by Schnorr signature aggregation. Each feed is a dedicated oracle contract, and reads are access-controlled: a caller must be whitelisted ("kissed") by the oracle's ward, or whitelist itself via the SelfKisser contract on supported test networks, before a read succeeds.

Supported chains: Ethereum (ETH/USD, BTC/USD, USDC/USD, USDT/USD, Custom Oracle), Sepolia (all named feeds plus Custom Oracle and SelfKisser). Read-only actions work without credentials once the caller is whitelisted on the target oracle.

## Actions

Actions are grouped below by contract: each named feed is a separate oracle contract with its own address, the Custom Oracle lets you point at any Chronicle oracle address, and SelfKisser is a testnet-only whitelisting helper.

### Named Price Feeds

Each of the six feeds below exposes the same two read actions, with the feed name as a prefix.

| Feed Contract | Read Action Slug | Read with Age Slug |
|----------------|-------------------|----------------------|
| ETH/USD Oracle | `eth-usd-read` | `eth-usd-read-with-age` |
| BTC/USD Oracle | `btc-usd-read` | `btc-usd-read-with-age` |
| DAI/USD Oracle | `dai-usd-read` | `dai-usd-read-with-age` |
| USDC/USD Oracle | `usdc-usd-read` | `usdc-usd-read-with-age` |
| USDT/USD Oracle | `usdt-usd-read` | `usdt-usd-read-with-age` |
| LINK/USD Oracle | `link-usd-read` | `link-usd-read-with-age` |

**Read {Feed} Value** (for example "Read ETH/USD Value"): reads the current price from the feed. Caller must be whitelisted (kissed).

**Inputs:** None

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| value | uint256 | Oracle Value, 18 decimals |

**Read {Feed} Value with Age** (for example "Read ETH/USD Value with Age"): reads the current price and its last-updated timestamp.

**Inputs:** None

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| value | uint256 | Oracle Value, 18 decimals |
| age | uint256 | Last Updated (Unix timestamp) |

**When to use:** Feed a strategy or alert off a live, cryptographically verified price without depending on a separate price API. Use the "with Age" variant to check for stale data before acting on it.

DAI/USD and LINK/USD are published on Sepolia only; Chronicle does not publish those pairs on Ethereum mainnet.

### Custom Chronicle Oracle

Lets you point at any Chronicle oracle contract address rather than one of the named feeds above.

| Action | Slug | Type | Description |
|--------|------|------|-------------|
| Read Oracle Value (Custom) | `read` | Read | Read the current price value from any Chronicle oracle |
| Try Read Oracle Value (Custom) | `try-read` | Read | Attempt to read the current price; returns `ok=false` instead of reverting if not whitelisted |
| Read Oracle Value with Age (Custom) | `read-with-age` | Read | Read the current price value and its last-updated timestamp |
| Try Read Oracle Value with Age (Custom) | `try-read-with-age` | Read | Attempt to read price and age; returns `ok=false` instead of reverting if not whitelisted |

The "Try" variants are useful when the workflow can't guarantee the caller has been whitelisted on the target oracle, since they return a success flag instead of reverting.

### SelfKisser (Testnets Only)

| Action | Slug | Type | Description |
|--------|------|------|-------------|
| Whitelist on Oracle (Self) | `self-kiss` | Write | Whitelist the caller on a Chronicle oracle using the SelfKisser contract |

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| oracle | address | Oracle Contract Address |

Available on Sepolia and other Chronicle test networks. Mainnet does not allow self-whitelisting; mainnet oracles are whitelisted by an authorized ward.

---

## Example Workflows

### ETH/USD Price Alert

`Schedule (every 5 min) -> Chronicle: Read ETH/USD Value -> Math (divide by 1e18) -> Condition (< threshold) -> Discord: Send Message`

Poll the Chronicle ETH/USD feed and alert when price crosses a threshold.

### Stale Feed Check

`Schedule (hourly) -> Chronicle: Read ETH/USD Value with Age -> Code (now - age) -> Condition (> max staleness) -> Discord: Send Message`

Read the feed's last-updated timestamp alongside its value and alert if the feed hasn't updated recently.

---

## Supported Chains

| Chain | Contracts Available |
|-------|-------------------|
| Ethereum (1) | ETH/USD, BTC/USD, USDC/USD, USDT/USD, Custom Oracle |
| Sepolia (11155111) | ETH/USD, BTC/USD, DAI/USD, USDC/USD, USDT/USD, LINK/USD, Custom Oracle, SelfKisser |

The full, current action list for this protocol is available in the app's action grid and via the `search_protocol_actions` MCP tool.
