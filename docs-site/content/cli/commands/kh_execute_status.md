## kh execute status

Show the status of an execution

### Synopsis

Show the status of a direct blockchain execution (transfer or contract call).
Use --watch to poll until the execution reaches a terminal state.

See also: kh r st, kh ex transfer, kh ex cc

```
kh execute status <execution-id> [flags]
```

### Examples

```
  # Show execution status
  kh ex st abc123

  # Watch until completion
  kh ex st abc123 --watch
```

### Options

```
  -h, --help    help for status
      --watch   Live-update until complete
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

* [kh execute](kh_execute.md)	 - Execute direct blockchain actions

