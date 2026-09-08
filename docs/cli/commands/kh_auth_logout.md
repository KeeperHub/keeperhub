## kh auth logout

Log out of KeeperHub

### Synopsis

Remove stored credentials for the current host. The token is deleted from
the system keyring and cleared from the hosts config file.

See also: kh auth login, kh auth status

```
kh auth logout [flags]
```

### Examples

```
  # Log out of the default host
  kh auth logout

  # Log out of a specific host
  kh auth logout --host staging.keeperhub.io
```

### Options

```
  -h, --help   help for logout
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

* [kh auth](kh_auth.md)	 - Authenticate with KeeperHub

