## kh auth login

Log in to KeeperHub

### Synopsis

Authenticate with KeeperHub using the device code flow.
Prints a URL and a one-time code. Open the URL in any browser (the browser
does not open automatically — copy the URL from the terminal) and enter the
code to complete sign-in. Codes expire after 15 minutes.
Use --with-token to read an API key from stdin for non-interactive automation.

See also: kh auth status, kh auth logout

```
kh auth login [flags]
```

### Examples

```
  # Log in (device code flow)
  kh auth login

  # Log in with an API key (non-interactive)
  echo "kh_xxx" | kh auth login --with-token
```

### Options

```
      --force        Log in again even if a valid credential is stored, creating a new API key
  -h, --help         help for login
      --with-token   Read token from stdin
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

