## kh execute

Execute direct blockchain actions

### Synopsis

Execute blockchain operations directly without building a full workflow.
Supports token transfers and smart contract calls. Returns execution IDs
immediately; use --wait to block until completion.

See also: kh r st, kh wf run

### Examples

```
  # Transfer ETH on a chain
  kh ex transfer --chain 1 --to 0xABCD... --amount 0.01

  # Call a smart contract method
  kh ex cc --chain 1 --contract 0x... --method balanceOf --args '["0x..."]'
```

### Options

```
  -h, --help   help for execute
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
* [kh execute contract-call](kh_execute_contract-call.md)	 - Call a smart contract method
* [kh execute status](kh_execute_status.md)	 - Show the status of an execution
* [kh execute transfer](kh_execute_transfer.md)	 - Transfer tokens

