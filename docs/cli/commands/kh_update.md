## kh update

Update kh to the latest version

### Synopsis

Update kh to the latest version by downloading the newest release from GitHub.

If kh was installed via Homebrew, this command will print the appropriate
brew command to use instead of replacing the binary directly. Homebrew manages
its own binary lifecycle and must be used to keep the installation consistent.

```
kh update [flags]
```

### Examples

```
  # Check for and install the latest version
  kh update
```

### Options

```
  -h, --help   help for update
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

