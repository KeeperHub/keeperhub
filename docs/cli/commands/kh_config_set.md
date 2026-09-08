## kh config set

Set a configuration value

### Synopsis

Persist a configuration key-value pair to the config file. Changes take
effect immediately on the next command run. Use 'kh config list' to see
all valid keys.

See also: kh config list, kh config get

```
kh config set <key> <value> [flags]
```

### Examples

```
  # Set the default host
  kh config set default_host app.keeperhub.com

  # Point CLI at a self-hosted instance
  kh config set default_host https://kh.mycompany.io
```

### Options

```
  -h, --help   help for set
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

