---
title: "CLI"
description: "KeeperHub command-line interface for managing workflows, executing blockchain actions, and integrating with CI/CD pipelines."
---

# CLI

The KeeperHub CLI (`kh`) lets you manage workflows, execute blockchain actions, and monitor runs from the terminal. It is designed for scripting, CI/CD pipelines, and AI-assisted workflows via MCP.

## Install

**Homebrew (macOS/Linux):**
```
brew install keeperhub/tap/kh
```

**Go install:**
```
go install github.com/keeperhub/cli/cmd/kh@latest
```

**Binary download:** Download from [GitHub Releases](https://github.com/keeperhub/cli/releases) and add to your PATH.

## Authenticate

```
kh auth login
```

For CI/CD environments, set the `KH_API_KEY` environment variable instead.

## What's in this section

- [Quickstart](./cli/quickstart) -- install, authenticate, and run your first commands
- [Concepts](./cli/concepts) -- authentication model, output formats, configuration, MCP mode
- [Commands](./cli/commands) -- full reference for every `kh` command
