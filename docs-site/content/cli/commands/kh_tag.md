## kh tag

Manage tags

### Examples

```
  # List all tags
  kh t ls

  # Create a new tag
  kh t create "my-tag"
```

### Options

```
  -h, --help        help for tag
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
* [kh tag create](kh_tag_create.md)	 - Create a tag
* [kh tag delete](kh_tag_delete.md)	 - Delete a tag
* [kh tag get](kh_tag_get.md)	 - Get a tag
* [kh tag list](kh_tag_list.md)	 - List tags

