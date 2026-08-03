## kh plugin get

Get plugin details and available actions

```
kh plugin get <plugin-name> [flags]
```

### Examples

```
  # Get plugin reference card
  kh plugin g aave

  # Get plugin details as JSON
  kh plugin g morpho --json
```

### Options

```
  -h, --help      help for get
      --refresh   Bypass local cache and fetch fresh data
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

* [kh plugin](kh_plugin.md)	 - Browse available plugins and integrations

