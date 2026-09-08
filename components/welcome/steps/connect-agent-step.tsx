"use client";

import { Boxes } from "lucide-react";
import { motion } from "motion/react";
import { useRouter } from "next/navigation";
import {
  type ComponentType,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
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
import { ConnectAgentPreview } from "@/components/welcome/previews";
import { WelcomeShell } from "@/components/welcome/welcome-shell";
import {
  type AgentFramework,
  getAgentFrameworks,
} from "@/lib/agent-connect-commands";
import { api } from "@/lib/api-client";
import { BILLING_API } from "@/lib/billing/constants";
import { markOnboardingComplete } from "@/lib/welcome-status";

const BACK_PATH = "/welcome/pay-per-execution";

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

// Animates its own height as its children change size, so swapping tab content
// of different heights eases instead of snapping. Zero-height reads (during the
// tab-content swap) are ignored so the panel never collapses.
function AnimatedHeight({
  children,
}: {
  children: ReactNode;
}): React.ReactElement {
  const ref = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number | undefined>(undefined);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) {
      return;
    }
    const measure = (): void => {
      const next = el.scrollHeight;
      if (next > 0) {
        setHeight(next);
      }
    };
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    measure();
    return () => observer.disconnect();
  }, []);
  return (
    <motion.div
      animate={{ height: height ?? "auto" }}
      className="overflow-hidden"
      initial={false}
      transition={{ duration: 0.4, ease: "easeInOut" }}
    >
      <div ref={ref}>{children}</div>
    </motion.div>
  );
}

// One labeled tab group (its own heading + tabs + setup snippet). Both groups
// render stacked so the whole step is visible without a second selector.
function FrameworkGroup({
  label,
  frameworks,
  onSelect,
}: {
  label: string;
  frameworks: AgentFramework[];
  onSelect: (id: string) => void;
}): React.ReactElement {
  return (
    <div className="flex flex-col gap-2">
      <p className="font-medium text-sm">{label}</p>
      <Tabs defaultValue={frameworks[0]?.id} onValueChange={onSelect}>
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
        <AnimatedHeight>
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
                <p className="text-muted-foreground text-xs">
                  {framework.note}
                </p>
              ) : null}
            </TabsContent>
          ))}
        </AnimatedHeight>
      </Tabs>
    </div>
  );
}

/**
 * Wizard step 3: connect an AI agent to KeeperHub. Shows the MCP endpoint and
 * per-framework setup commands, grouped into Agents and Plugins. Every client
 * signs in through the browser (OAuth) -- no API key required.
 */
export function ConnectAgentStep(): React.ReactElement {
  const router = useRouter();
  const [finishing, setFinishing] = useState(false);
  // The tab last selected in either group drives the preview's branded UI.
  const [activeId, setActiveId] = useState("claude-code");
  const [mcpUrl, setMcpUrl] = useState(
    process.env.NEXT_PUBLIC_APP_URL
      ? `${process.env.NEXT_PUBLIC_APP_URL}/mcp`
      : ""
  );
  const [paygEnabled, setPaygEnabled] = useState(false);

  useEffect(() => {
    if (!mcpUrl) {
      setMcpUrl(`${window.location.origin}/mcp`);
    }
  }, [mcpUrl]);

  useEffect(() => {
    let cancelled = false;
    const loadPayg = async (): Promise<void> => {
      try {
        const res = await fetch(BILLING_API.PAYG, { cache: "no-store" });
        if (!res.ok) {
          return;
        }
        const data = (await res.json()) as { enabled?: boolean };
        if (!cancelled) {
          setPaygEnabled(Boolean(data.enabled));
        }
      } catch {
        // PAYG status is best-effort here; leave it disabled on failure.
      }
    };
    loadPayg().catch(() => undefined);
    return (): void => {
      cancelled = true;
    };
  }, []);

  // Enabling pay-as-you-go on the previous step is provisional: going back undoes
  // it (disable + clear caps) so the user makes a fresh choice.
  const handleBack = async (): Promise<void> => {
    if (paygEnabled) {
      await fetch(BILLING_API.PAYG, { method: "DELETE" }).catch(
        () => undefined
      );
    }
    router.push(BACK_PATH);
  };

  const frameworks = getAgentFrameworks(mcpUrl || "/mcp");
  const agents = frameworks.filter((f) => f.group === "mcp");
  const plugins = frameworks.filter((f) => f.group === "plugin");

  // Persist completion, then hard-navigate so the session is refetched
  // server-side with the new flag. Open the first seeded example workflow on
  // the canvas instead of an empty one; fall back home if there are none.
  const finish = async (): Promise<void> => {
    setFinishing(true);
    await markOnboardingComplete();
    try {
      const all = await api.workflow.getAll();
      const first = [...all].sort(
        (a, b) =>
          new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
      )[0];
      if (first) {
        window.location.assign(`/workflows/${first.id}`);
        return;
      }
    } catch {
      // fall through to home
    }
    window.location.assign("/");
  };

  return (
    <WelcomeShell
      busy={finishing}
      contentClassName="max-w-none"
      description="Point your AI agent at KeeperHub over MCP, then drive workflows and wallets from your editor."
      nextLabel="Finish"
      onBack={handleBack}
      onNext={finish}
      preview={<ConnectAgentPreview frameworkId={activeId} />}
      stepIndex={3}
      title="Connect your AI agent"
    >
      <div className="flex flex-col gap-6">
        <div className="flex flex-col gap-2">
          <p className="font-medium text-sm">MCP endpoint</p>
          <CopyBlock body={mcpUrl || `${"{origin}"}/mcp`} />
        </div>

        <FrameworkGroup
          frameworks={agents}
          label="Agents"
          onSelect={setActiveId}
        />
        <FrameworkGroup
          frameworks={plugins}
          label="Plugins"
          onSelect={setActiveId}
        />
      </div>
    </WelcomeShell>
  );
}
