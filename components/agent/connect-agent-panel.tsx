"use client";

import { Boxes, Sparkles } from "lucide-react";
import { type ComponentType, useEffect, useState } from "react";
import { toast } from "sonner";
import {
  ClaudeCodeIcon,
  ClaudeIcon,
  EveIcon,
  GeminiIcon,
  GooseIcon,
  HermesIcon,
  OpenAIIcon,
  OpenClawIcon,
} from "@/components/icons/agent-icons";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { CopyBlock } from "@/components/welcome/copy-block";
import {
  type AgentFramework,
  getAgentFrameworks,
} from "@/lib/agent-connect-commands";

const TAB_ICONS: Record<string, ComponentType<{ className?: string }>> = {
  "claude-code": ClaudeCodeIcon,
  "claude-desktop": ClaudeIcon,
  "claude-plugin": ClaudeIcon,
  openclaw: OpenClawIcon,
  codex: OpenAIIcon,
  "gemini-cli": GeminiIcon,
  goose: GooseIcon,
  hermes: HermesIcon,
  eve: EveIcon,
  other: Boxes,
};

const SUGGESTED_PROMPTS = [
  "Create a workflow that checks my stETH rewards every hour and alerts me on Discord when they are ready to redeem",
  "Ping me on Telegram when a withdrawal over 10 ETH leaves my treasury",
  "Watch my Aave v3 health factor and message me if it drops below 1.5",
];

// One labeled tab group (heading + tabs + per-framework setup snippet).
function FrameworkGroup({
  label,
  frameworks,
}: {
  label: string;
  frameworks: AgentFramework[];
}): React.ReactElement {
  return (
    <div className="flex flex-col gap-2">
      <p className="font-medium text-sm">{label}</p>
      <Tabs defaultValue={frameworks[0]?.id}>
        <TabsList className="h-auto flex-wrap justify-start gap-1 bg-muted/20">
          {frameworks.map((framework) => {
            const Icon = TAB_ICONS[framework.id] ?? Boxes;
            return (
              <TabsTrigger
                className="flex-none gap-1.5 px-4 py-1.5"
                key={framework.id}
                value={framework.id}
              >
                <Icon className="size-3.5" />
                {framework.label}
              </TabsTrigger>
            );
          })}
        </TabsList>
        {frameworks.map((framework) => (
          <TabsContent
            className="flex flex-col gap-2 pt-2"
            key={framework.id}
            value={framework.id}
          >
            {framework.snippets.map((snippet) => (
              <CopyBlock
                body={snippet.body}
                caption={snippet.caption}
                key={snippet.caption}
              />
            ))}
            {framework.note ? (
              <p className="text-muted-foreground text-xs">{framework.note}</p>
            ) : null}
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}

/**
 * MCP endpoint, per-framework setup commands and starter prompts. Rendered
 * inline in settings and inside the legacy overlay so there is one source.
 */
export function useMcpUrl(): string {
  const [mcpUrl, setMcpUrl] = useState(
    process.env.NEXT_PUBLIC_APP_URL
      ? `${process.env.NEXT_PUBLIC_APP_URL}/mcp`
      : ""
  );
  useEffect(() => {
    if (!mcpUrl) {
      setMcpUrl(`${window.location.origin}/mcp`);
    }
  }, [mcpUrl]);
  return mcpUrl || "/mcp";
}

/** Per-client setup commands, grouped into agents and editor plugins. */
export function AgentFrameworkGroups(): React.ReactElement {
  const mcpUrl = useMcpUrl();
  const frameworks = getAgentFrameworks(mcpUrl);
  return (
    <div className="flex flex-col gap-6">
      <FrameworkGroup
        frameworks={frameworks.filter((f) => f.group === "mcp")}
        label="Agents"
      />
      <FrameworkGroup
        frameworks={frameworks.filter((f) => f.group === "plugin")}
        label="Plugins"
      />
    </div>
  );
}

/** Copy-to-clipboard starter prompts. */
export function AgentStarterPrompts(): React.ReactElement {
  const copyPrompt = (prompt: string): void => {
    navigator.clipboard
      .writeText(prompt)
      .then(() => toast.success("Copied to clipboard"))
      .catch(() => undefined);
  };
  return (
    <div className="flex flex-col gap-2">
      {SUGGESTED_PROMPTS.map((prompt) => (
        <button
          className="rounded-lg border bg-muted/20 px-3 py-2.5 text-left text-foreground text-sm transition-colors hover:bg-muted/50"
          key={prompt}
          onClick={() => copyPrompt(prompt)}
          type="button"
        >
          {prompt}
        </button>
      ))}
    </div>
  );
}

export function ConnectAgentPanel(): React.ReactElement {
  const [mcpUrl, setMcpUrl] = useState(
    process.env.NEXT_PUBLIC_APP_URL
      ? `${process.env.NEXT_PUBLIC_APP_URL}/mcp`
      : ""
  );

  useEffect(() => {
    if (!mcpUrl) {
      setMcpUrl(`${window.location.origin}/mcp`);
    }
  }, [mcpUrl]);

  const frameworks = getAgentFrameworks(mcpUrl || "/mcp");
  const agents = frameworks.filter((f) => f.group === "mcp");
  const plugins = frameworks.filter((f) => f.group === "plugin");

  const copyPrompt = (prompt: string): void => {
    navigator.clipboard
      .writeText(prompt)
      .then(() => toast.success("Copied to clipboard"))
      .catch(() => undefined);
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <p className="font-medium text-sm">MCP endpoint</p>
        <CopyBlock body={mcpUrl || `${"{origin}"}/mcp`} />
      </div>

      <FrameworkGroup frameworks={agents} label="Agents" />
      <FrameworkGroup frameworks={plugins} label="Plugins" />

      <div className="flex flex-col gap-2">
        <p className="flex items-center gap-2 font-medium text-sm">
          <Sparkles className="size-4 text-primary" />
          Try a prompt
        </p>
        {SUGGESTED_PROMPTS.map((prompt) => (
          <button
            className="rounded-lg border border-border bg-muted/30 px-3 py-2.5 text-left text-foreground text-sm transition-colors hover:border-keeperhub-green/60"
            key={prompt}
            onClick={() => copyPrompt(prompt)}
            type="button"
          >
            {prompt}
          </button>
        ))}
      </div>
    </div>
  );
}
