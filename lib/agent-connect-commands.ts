// Per-framework setup snippets for connecting an AI agent / MCP client to
// KeeperHub. Every client authenticates with the browser OAuth flow -- no API
// key and no bearer header. The canonical commands live in docs/ai-tools; this
// module is the single source the onboarding UI renders so the two don't drift.

export type AgentSnippet = {
  // A caption shown above the code block (e.g. a filename or "Run this").
  caption: string;
  // The command or config body to copy.
  body: string;
};

// "mcp": connect an agent to the MCP endpoint. "plugin": install a first-class
// KeeperHub plugin. The onboarding UI renders the two as separate tab groups.
export type AgentGroup = "mcp" | "plugin";

export type AgentFramework = {
  id: string;
  label: string;
  group: AgentGroup;
  snippets: AgentSnippet[];
  // Extra guidance shown under the snippets (e.g. the OAuth sign-in hint).
  note?: string;
};

/**
 * Build the framework setup snippets for the given MCP endpoint. Connections
 * authenticate through the browser (OAuth) the first time a KeeperHub tool is
 * used, so no key is embedded in any snippet.
 */
export function getAgentFrameworks(mcpUrl: string): AgentFramework[] {
  return [
    {
      id: "claude-code",
      label: "Claude Code",
      group: "mcp",
      snippets: [
        {
          caption: "Add the server",
          body: `claude mcp add --transport http --scope user keeperhub ${mcpUrl}`,
        },
      ],
      note: "Run /mcp in Claude Code and complete the browser sign-in when prompted.",
    },
    {
      id: "claude-desktop",
      label: "Claude Desktop",
      group: "mcp",
      snippets: [
        {
          caption: "claude_desktop_config.json",
          body: `{
  "mcpServers": {
    "keeperhub": {
      "command": "npx",
      "args": ["mcp-remote", "${mcpUrl}"]
    }
  }
}`,
        },
      ],
      note: "Add this to your config file, restart Claude Desktop, then approve the browser sign-in.",
    },
    {
      id: "openclaw",
      label: "OpenClaw",
      group: "mcp",
      snippets: [
        {
          caption: "MCP server config",
          body: `{
  "mcpServers": {
    "keeperhub": {
      "url": "${mcpUrl}"
    }
  }
}`,
        },
      ],
      note: "Add KeeperHub as an MCP server in OpenClaw, then approve the browser sign-in.",
    },
    {
      id: "codex",
      label: "Codex",
      group: "mcp",
      snippets: [
        {
          caption: "~/.codex/config.toml",
          body: `[mcp_servers.keeperhub]
url = "${mcpUrl}"`,
        },
      ],
    },
    {
      id: "goose",
      label: "Goose",
      group: "mcp",
      snippets: [
        {
          caption: "~/.config/goose/config.yaml",
          body: `extensions:
  keeperhub:
    type: streamable_http
    uri: ${mcpUrl}
    enabled: true`,
        },
      ],
      note: "Or run `goose configure` -> Add Extension -> Remote Extension (Streaming HTTP), then approve the browser sign-in.",
    },
    {
      id: "gemini-cli",
      label: "Gemini CLI",
      group: "mcp",
      snippets: [
        {
          caption: "~/.gemini/settings.json",
          body: `{
  "mcpServers": {
    "keeperhub": {
      "httpUrl": "${mcpUrl}"
    }
  }
}`,
        },
      ],
      note: "Edit your settings file, restart Gemini CLI, then approve the browser sign-in.",
    },
    {
      id: "other",
      label: "Other agents",
      group: "mcp",
      snippets: [
        {
          caption: "mcpServers config (Windsurf, Cline, Continue, ...)",
          body: `{
  "mcpServers": {
    "keeperhub": {
      "type": "http",
      "url": "${mcpUrl}"
    }
  }
}`,
        },
      ],
      note: "Any MCP-compatible client can connect to the same endpoint. See docs.keeperhub.com for per-tool guides.",
    },
    {
      id: "claude-plugin",
      label: "Claude plugin",
      group: "plugin",
      snippets: [
        {
          caption: "Install the plugin",
          body: `/plugin marketplace add KeeperHub/claude-plugins
/plugin install keeperhub@keeperhub-plugins`,
        },
        {
          // The plugin's commands only register on restart, so /keeperhub:login
          // is a separate snippet rather than a third line above.
          caption: "Restart Claude Code, then sign in",
          body: "/keeperhub:login",
        },
      ],
      note: "Run /keeperhub:status to verify the connection.",
    },
    {
      id: "hermes",
      label: "Hermes plugin",
      group: "plugin",
      snippets: [
        {
          caption: "Install the plugin",
          body: "hermes plugins install KeeperHub/hermes-plugin --enable",
        },
      ],
      note: "Gives your Hermes agent kh_* tools to manage and run on-chain workflows over the KeeperHub MCP API.",
    },
    {
      id: "eve",
      label: "Eve plugin",
      group: "plugin",
      snippets: [
        {
          caption: "Install the connection",
          body: "npm install keeperhub-eve-plugin",
        },
      ],
      note: "Adds KeeperHub tools to a scaffolded Eve agent -- no endpoint or auth wiring to manage.",
    },
  ];
}
