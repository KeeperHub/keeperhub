## kh config get

Get a configuration value

```
kh config get <key> [flags]
```

### Examples

```
  # Get the default host
  kh config get default_host
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

* [kh config](kh_config.md)	 - Manage CLI configuration

