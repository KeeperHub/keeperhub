## kh workflow disable

Disable a workflow so it stops running

### Synopsis

Disable a workflow so it stops running.

Turns off a workflow without deleting it. Runs already in flight are unaffected;
the trigger simply stops firing new ones.

See also: kh workflow enable

```
kh workflow disable <workflow-id> [flags]
```

### Examples

```
  # Disable a workflow (will prompt for confirmation)
  kh wf disable abc123

  # Disable without prompting
  kh wf disable abc123 --yes

  # pause is an alias and still works
  kh wf pause abc123
```

### Options

```
  -h, --help   help for disable
  -y, --yes    Skip confirmation prompt
```

### Options inherited from parent commands

```
  -H, --host string   KeeperHub host (default: app.keeperhub.com)
      --jq string     Filter JSON output with a jq expression
      --json          Output as JSON
      --no-color      Disable color output
      --org string    Organization ID to use (overrides default from auth)
```

### SEE ALSO

* [kh workflow](kh_workflow.md)	 - Manage workflows

