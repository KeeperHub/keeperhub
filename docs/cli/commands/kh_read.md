## kh read

Read a smart contract view function

### Synopsis

Call a read-only smart contract function via eth_call.

The function signature should be in Solidity format (e.g. "balanceOf(address)").
Arguments are positional and must match the function signature types.

Supported argument types: address, uint256, bool, bytes32.

No auth required. The RPC endpoint is yours to supply, via --rpc-url, the
KH_RPC_URL env var, or an rpc.<chain-id> entry in the config file.

```
kh read <contract-address> <function-signature> [args...] [flags]
```

### Examples

```
  # Read USDT total supply
  kh read 0xdAC17F958D2ee523a2206206994597C96e3cFa0e "totalSupply()" --chain 1

  # Read ERC-20 balance
  kh read 0x6B175474E89094C44Da98b954EedeAC495271d0F "balanceOf(address)" 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045 --chain 1

  # Read token decimals
  kh read 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 "decimals()" --chain 1

  # Use a custom RPC endpoint
  kh read 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 "decimals()" --chain 1 --rpc-url https://eth.llamarpc.com
```

### Options

```
      --block string     Block number or tag (default: latest)
      --chain string     Chain ID (required)
  -h, --help             help for read
      --raw              Output raw hex instead of decoded
      --rpc-url string   Override RPC endpoint
```

### Options inherited from parent commands

```
  -H, --host string   KeeperHub host (default: app.keeperhub.com)
      --jq string     Filter JSON output with a jq expression
      --json          Output as JSON
      --no-color      Disable color output
      --org string    Organization ID to use (overrides default from auth)
  -y, --yes           Skip confirmation prompts
```

### SEE ALSO

* [kh](kh.md)	 - KeeperHub CLI

