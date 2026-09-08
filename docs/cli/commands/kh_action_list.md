## kh action list

List available actions

```
kh action list [flags]
```

### Examples

```
  # List all actions
  kh a ls

  # Filter by category
  kh a ls --category web3
```

### Options

```
      --category string   Filter by category
  -h, --help              help for list
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

