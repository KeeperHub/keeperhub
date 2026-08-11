---
title: "CLI"
description: "Install the kh CLI, authenticate, and run your first KeeperHub workflow from a terminal."
---

# Getting Started with the CLI

`kh` manages workflows, runs, and onchain actions from a terminal. It is the shortest path to a
working result if you already have a shell open.

## 1. Install

**Homebrew (macOS and Linux):**

```bash
brew install keeperhub/tap/kh
```

**Go:**

```bash
go install github.com/keeperhub/cli/cmd/kh@latest
```

**Linux without Homebrew:**

```bash
mkdir -p ~/.local/bin && cd "$(mktemp -d)"
curl -fsSL https://api.github.com/repos/keeperhub/cli/releases/latest \
  | grep browser_download_url | cut -d '"' -f 4 \
  | grep -E 'linux_amd64\.tar\.gz|checksums\.txt' \
  | xargs -n1 curl -fsSLO
sha256sum --ignore-missing -c checksums.txt
tar -xzf kh_*_linux_amd64.tar.gz -C ~/.local/bin kh
```

Use `linux_arm64` on ARM, and make sure `~/.local/bin` is on your `PATH`. The unauthenticated
GitHub API allows 60 requests per hour per IP; if you hit that, download directly from
[GitHub Releases](https://github.com/keeperhub/cli/releases).

Check the install with `kh version`, or `kh doctor` for a fuller diagnosis.

## 2. Authenticate

```bash
kh auth login
```

This uses the device code flow: it prints a URL and a short code. Open the URL in any browser,
including on another machine, and enter the code. Codes expire after 15 minutes; re-run the
command if yours does. Completing the flow mints an organization API key and stores the token in
your OS keyring.

For CI, skip the interactive flow and set `KH_API_KEY` to an organization key created in the app
under your avatar, then **API Keys**, then the **Organisation** tab.

Confirm with `kh auth status`.

## 3. Run a workflow

```bash
kh workflow list
```

Take an id from that list and run it, blocking until it finishes:

```bash
kh workflow run <workflow-id> --wait --timeout 2m
```

Without `--wait` the command returns the execution id immediately. `--wait` defaults to a 5 minute
timeout.

Then inspect the run:

```bash
kh run status <run-id>
kh run logs <run-id>
```

## 4. Call a contract directly

For a one-off call with no workflow around it:

```bash
# Read a value
kh execute contract-call --chain 1 --contract 0x... --method balanceOf --args '["0x..."]'

# Write, and wait for the transaction
kh execute contract-call --chain 1 --contract 0x... --method transfer \
  --args '["0x...","1000"]' --wait
```

`--args` takes a **JSON array** of positional arguments, matching the method signature. Pass
`--abi-file` when the ABI cannot be fetched automatically.

To discover what is available:

```bash
kh plugin list      # integrations
kh action list      # actions across integrations
kh chain list       # supported chains and ids
```

## Connecting an AI assistant

Point your assistant at the hosted MCP endpoint rather than running a local server:

```bash
claude mcp add --transport http --scope user keeperhub https://app.keeperhub.com/mcp
```

`kh serve --mcp` still starts a local stdio MCP server, but that mode is deprecated. See
[Agent](/getting-started/agent).

## Next

- [CLI Overview](/cli) and [Concepts](/cli/concepts) for authentication, output formats, and
  configuration
- [Command reference](/cli/commands/kh) for every command and flag
- `--json` with `--jq` on any command for scriptable output
