## kh plugin list

List available plugins and integrations

```
kh plugin list [flags]
```

### Examples

```
  # List all plugins (cached)
  kh plugin ls

  # Force refresh from API
  kh plugin ls --refresh
```

### Options

```
  -h, --help      help for list
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

