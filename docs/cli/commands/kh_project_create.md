## kh project create

Create a project

```
kh project create <name> [flags]
```

### Examples

```
  # Create a project
  kh p create "My Project"

  # Create with a description
  kh p create "DeFi Automations" --description "Uniswap and Aave workflows"
```

### Options

```
      --description string   Project description
  -h, --help                 help for create
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

* [kh project](kh_project.md)	 - Manage projects

