## kh template deploy

Deploy a workflow template

```
kh template deploy <template-id> [flags]
```

### Examples

```
  # Deploy a template using its ID
  kh tp deploy abc123

  # Deploy and give it a custom name
  kh tp deploy abc123 --name "My Uniswap Workflow"
```

### Options

```
  -h, --help          help for deploy
      --name string   Workflow name
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

* [kh template](kh_template.md)	 - Manage workflow templates

