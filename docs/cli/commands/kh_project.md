## kh project

Manage projects

### Examples

```
  # List all projects
  kh p ls

  # Create a new project
  kh p create "My Project"
```

### Options

```
  -h, --help        help for project
      --jq string   Filter JSON output with a jq expression
      --json        Output as JSON
  -y, --yes         Skip confirmation prompts
```

### Options inherited from parent commands

```
  -H, --host string   KeeperHub host (default: app.keeperhub.com)
      --no-color      Disable color output
      --org string    Organization ID to use (overrides default from auth)
```

### SEE ALSO

* [kh](kh.md)	 - KeeperHub CLI
* [kh project create](kh_project_create.md)	 - Create a project
* [kh project delete](kh_project_delete.md)	 - Delete a project
* [kh project get](kh_project_get.md)	 - Get a project
* [kh project list](kh_project_list.md)	 - List projects

