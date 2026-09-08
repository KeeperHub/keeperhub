## kh billing status

Show billing status

```
kh billing status [flags]
```

### Examples

```
  # Show billing plan and usage
  kh b st

  # Show as JSON
  kh b st --json
```

### Options

```
  -h, --help   help for status
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

* [kh billing](kh_billing.md)	 - View billing and usage

