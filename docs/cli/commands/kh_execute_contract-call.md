## kh execute contract-call

Call a smart contract method

```
kh execute contract-call [flags]
```

### Examples

```
  # Call a read-only method (returns result immediately)
  kh ex cc --chain 1 --contract 0x... --method balanceOf --args '["0x..."]'

  # Call a write method and wait for the transaction
  kh ex cc --chain 1 --contract 0x... --method transfer --args '["0x...","1000"]' --wait
```

### Options

```
      --abi-file string          Path to local ABI JSON file
      --args string              Method arguments as JSON array: '["arg1","arg2"]'
      --chain string             Chain ID (required)
      --contract string          Contract address (required)
  -h, --help                     help for contract-call
      --idempotency-key string   Stable Idempotency-Key for write intents (auto-generated if empty)
      --method string            Method name (required)
      --timeout duration         Timeout when using --wait (default 5m0s)
      --wait                     Wait for completion
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

* [kh execute](kh_execute.md)	 - Execute direct blockchain actions

