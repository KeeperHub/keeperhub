## kh billing

View billing and usage

### Examples

```
  # Show billing status
  kh b st

  # Show usage for current period
  kh b u
```

### Options

```
  -h, --help        help for billing
      --jq string   Filter JSON output with a jq expression
      --json        Output as JSON
```

### Options inherited from parent commands

```
  -H, --host string   KeeperHub host (default: app.keeperhub.com)
      --no-color      Disable color output
      --org string    Organization ID to use (overrides default from auth)
  -y, --yes           Skip confirmation prompts
```

### SEE ALSO

* [kh](kh.md)	 - KeeperHub CLI
* [kh billing status](kh_billing_status.md)	 - Show billing status
* [kh billing usage](kh_billing_usage.md)	 - Show billing usage

