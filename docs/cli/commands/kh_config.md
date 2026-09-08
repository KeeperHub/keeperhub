## kh config

Manage CLI configuration

### Examples

```
  # List all config values
  kh config ls

  # Set the default host
  kh config set default_host app.keeperhub.com
```

### Options

```
  -h, --help   help for config
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
* [kh config get](kh_config_get.md)	 - Get a configuration value
* [kh config list](kh_config_list.md)	 - List all configuration values
* [kh config set](kh_config_set.md)	 - Set a configuration value

