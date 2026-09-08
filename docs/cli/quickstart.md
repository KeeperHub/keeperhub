---
title: "Quickstart"
description: "KeeperHub CLI Quickstart"
---

# Quickstart

## Install

**Homebrew (macOS/Linux with Homebrew):**
```
brew install keeperhub/tap/kh
```

**Linux (no Homebrew / headless):**
```bash
mkdir -p ~/.local/bin && cd "$(mktemp -d)"
curl -fsSL https://api.github.com/repos/keeperhub/cli/releases/latest \
  | grep browser_download_url | cut -d '"' -f 4 \
  | grep -E 'linux_amd64\.tar\.gz|checksums\.txt' \
  | xargs -n1 curl -fsSLO
sha256sum --ignore-missing -c checksums.txt
tar -xzf kh_*_linux_amd64.tar.gz -C ~/.local/bin kh
```
Replace `linux_amd64` with `linux_arm64` on ARM. Ensure `~/.local/bin` is on your `PATH`.
The unauthenticated GitHub API is rate-limited to 60 requests per hour per IP; if you hit that limit, download directly from [GitHub Releases](https://github.com/keeperhub/cli/releases).

**Go install:**
```
go install github.com/keeperhub/cli/cmd/kh@latest
```

**Binary download:** Download from [GitHub Releases](https://github.com/keeperhub/cli/releases) and add to your PATH.

## Authenticate

```
kh auth login
```

This uses the **device code flow**: it prints a URL and a short code. Open the URL in any browser (including on a different machine) and enter the code to complete sign-in. On headless or remote boxes the browser will not open automatically — copy the URL from the terminal. Codes expire after 15 minutes; re-run `kh auth login` if yours expires. Your token is stored in the OS keyring.

To authenticate non-interactively (CI/CD), set `KH_API_KEY` instead.

## Common Commands

**List workflows:**
```
kh workflow list
```

**Run a workflow and wait for completion:**
```
kh workflow run <workflow-id> --wait
```

**Check a run's status:**
```
kh run status <run-id>
```

**View run logs:**
```
kh run logs <run-id>
```

**Execute a contract call:**
```
kh execute contract-call --protocol aave --action supply --args '{"amount":"1000000"}'
```

**List available protocols:**
```
kh protocol list
```

## MCP Server Mode

KeeperHub exposes its actions as tools to AI assistants via the [Model Context Protocol](https://modelcontextprotocol.io).

**Recommended: remote HTTP endpoint (no local server required):**
```
claude mcp add --transport http --scope user keeperhub https://app.keeperhub.com/mcp
```

**Add to Claude Desktop** (`~/Library/Application Support/Claude/claude_desktop_config.json`):
```json
{ "mcpServers": { "keeperhub": { "type": "http", "url": "https://app.keeperhub.com/mcp" } } }
```

Restart Claude Desktop. KeeperHub tools will appear in the tool list.

**Legacy: local stdio server (deprecated):**

`kh serve --mcp` starts a local MCP stdio server. This mode is deprecated. Prefer the remote HTTP endpoint above.

## Next Steps

- [Concepts](./concepts) -- authentication, output formats, configuration
- [Command reference](./commands/kh) -- full documentation for every command
