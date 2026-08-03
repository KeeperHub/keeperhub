## kh action get

Get an action

```
kh action get <action-name> [flags]
```

### Examples

```
  # Get action by name
  kh a g ethereum-transfer

  # Get action details as JSON
  kh a g uniswap-swap --json
```

### Options

```
  -h, --help   help for get
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

* [kh action](kh_action.md)	 - Browse available actions

