## kh template

Manage workflow templates

### Examples

```
  # List available templates
  kh tp ls

  # Deploy a template to your account
  kh tp deploy abc123
```

### Options

```
  -h, --help        help for template
      --jq string   Filter JSON output with a jq expression
      --json        Output as JSON
```

### Options inherited from parent commands

```
  -H, --host string   KeeperHub host (default: app.keeperhub.com)
      --no-color      Disable color output
      --org string    Organization ID to use (overrides default from auth)
  -y, --yes           Skip confirmation prompts
```

### SEE ALSO

* [kh](kh.md)	 - KeeperHub CLI
* [kh template deploy](kh_template_deploy.md)	 - Deploy a workflow template
* [kh template list](kh_template_list.md)	 - List workflow templates

