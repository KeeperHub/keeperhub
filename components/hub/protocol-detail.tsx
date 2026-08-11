"use client";

import {
  ArrowLeft,
  ArrowUpRight,
  Box,
  ExternalLink,
  Headphones,
} from "lucide-react";
import { nanoid } from "nanoid";
import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api, type SavedWorkflow } from "@/lib/api-client";
import { authClient, useSession } from "@/lib/auth-client";
import { getChainName, getExplorerUrl } from "@/lib/chain-utils";
import {
  buildEventAbiFragment,
  type ProtocolAction,
  type ProtocolDefinition,
  type ProtocolEvent,
} from "@/lib/protocol-registry";
import { refetchSidebar } from "@/lib/refetch-sidebar";
import { WorkflowTemplateCard } from "./workflow-template-card";

type ProtocolDetailProps = {
  protocol: ProtocolDefinition;
  onBack?: () => void;
  hideBackButton?: boolean;
  modalUrl?: string;
  onTabChange?: () => void;
};

const TAB_TRIGGER_CLASS =
  "h-auto flex-none border-0 border-b-2 border-transparent rounded-none px-0 pb-2 data-[state=active]:border-b-[var(--color-text-accent)] data-[state=active]:bg-transparent data-[state=active]:shadow-none dark:data-[state=active]:border-b-[var(--color-text-accent)] dark:data-[state=active]:bg-transparent";

function ActionTypeBadge({
  type,
}: {
  type: "read" | "write";
}): React.ReactElement {
  if (type === "read") {
    return (
      <span className="rounded-full bg-muted px-2 py-0.5 font-medium text-[10px] text-muted-foreground uppercase tracking-wider">
        READ
      </span>
    );
  }

  return (
    <span className="rounded-full bg-[var(--color-bg-accent)] px-2 py-0.5 font-medium text-[var(--color-text-accent)] text-[10px] uppercase tracking-wider">
      WRITE
    </span>
  );
}

function ActionRow({
  action,
  isLast,
  isCreating,
  onUse,
}: {
  action: ProtocolAction;
  isLast: boolean;
  isCreating: boolean;
  onUse: () => void;
}): React.ReactElement {
  return (
    <div
      className={`flex items-center justify-between px-4 py-4 transition-colors hover:bg-muted/50 ${isLast ? "" : "border-b border-border/30"}`}
    >
      <div className="flex-1">
        <div className="flex items-center gap-2">
          <span className="font-semibold text-sm">{action.label}</span>
          <ActionTypeBadge type={action.type} />
        </div>
        <p className="mt-0.5 text-muted-foreground text-xs">
          {action.description}
        </p>
        {action.inputs.length > 0 ? (
          <p className="mt-1 text-muted-foreground text-xs">
            Inputs:{" "}
            {action.inputs.map((inp) => `${inp.name} (${inp.type})`).join(", ")}
          </p>
        ) : (
          <p className="mt-1 text-muted-foreground text-xs">
            No inputs required
          </p>
        )}
        {action.outputs && action.outputs.length > 0 && (
          <p className="mt-0.5 text-muted-foreground text-xs">
            Outputs:{" "}
            {action.outputs
              .map((out) => `${out.name} (${out.type})`)
              .join(", ")}
          </p>
        )}
        {(!action.outputs || action.outputs.length === 0) &&
          action.type === "read" && (
            <p className="mt-0.5 text-muted-foreground text-xs">
              Returns: success status
            </p>
          )}
      </div>
      <Button
        className="ml-4 shrink-0"
        disabled={isCreating}
        onClick={onUse}
        size="sm"
        variant="outline"
      >
        {isCreating ? "Creating..." : "Use in Workflow"}
      </Button>
    </div>
  );
}

function EventRow({
  event,
  isLast,
  isCreating,
  onListen,
}: {
  event: ProtocolEvent;
  isLast: boolean;
  isCreating: boolean;
  onListen: () => void;
}): React.ReactElement {
  return (
    <div
      className={`flex items-center justify-between px-4 py-4 transition-colors hover:bg-muted/50 ${isLast ? "" : "border-b border-border/30"}`}
    >
      <div className="flex-1">
        <div className="flex items-center gap-2">
          <span className="font-semibold text-sm">{event.label}</span>
          <span className="rounded-full bg-blue-500/10 px-2 py-0.5 font-medium text-blue-400 text-[10px] uppercase tracking-wider">
            EVENT
          </span>
        </div>
        <p className="mt-0.5 text-muted-foreground text-xs">
          {event.description}
        </p>
        <p className="mt-1 text-muted-foreground text-xs">
          {event.eventName}(
          {event.inputs
            .map(
              (inp) => `${inp.type}${inp.indexed ? " indexed" : ""} ${inp.name}`
            )
            .join(", ")}
          )
        </p>
      </div>
      <Button
        className="ml-4 shrink-0"
        disabled={isCreating}
        onClick={onListen}
        size="sm"
        variant="outline"
      >
        <Headphones className="mr-1.5 size-3.5" />
        {isCreating ? "Creating..." : "Listen to Event"}
      </Button>
    </div>
  );
}

function collectAllChains(
  contracts: ProtocolDefinition["contracts"]
): string[] {
  const chainSet = new Set<string>();
  for (const contract of Object.values(contracts)) {
    for (const chain of Object.keys(contract.addresses)) {
      chainSet.add(chain);
    }
  }
  return Array.from(chainSet);
}

export function ProtocolDetail({
  protocol,
  onBack,
  hideBackButton,
  modalUrl,
  onTabChange,
}: ProtocolDetailProps): React.ReactElement {
  const router = useRouter();
  const { data: session } = useSession();
  const [creatingActionSlug, setCreatingActionSlug] = useState<string | null>(
    null
  );
  const [creatingEventSlug, setCreatingEventSlug] = useState<string | null>(
    null
  );
  const [featuredWorkflows, setFeaturedWorkflows] = useState<SavedWorkflow[]>(
    []
  );
  const [duplicatingIds, setDuplicatingIds] = useState<Set<string>>(new Set());
  const allChains = collectAllChains(protocol.contracts);

  useEffect(() => {
    let cancelled = false;
    api.workflow
      .getProtocolFeatured(protocol.slug)
      .then((workflows) => {
        if (!cancelled) {
          setFeaturedWorkflows(workflows);
        }
      })
      .catch(() => {
        // Silently ignore -- featured workflows are optional
      });
    return () => {
      cancelled = true;
    };
  }, [protocol.slug]);

  async function handleDuplicate(workflowId: string): Promise<void> {
    if (duplicatingIds.has(workflowId)) {
      return;
    }

    setDuplicatingIds((prev) => new Set(prev).add(workflowId));

    try {
      if (!session?.user) {
        await authClient.signIn.anonymous();
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      const duplicated = await api.workflow.duplicate(workflowId);
      refetchSidebar();
      toast.success("Workflow duplicated successfully");
      router.push(`/workflows/${duplicated.id}`);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to duplicate workflow"
      );
    } finally {
      setDuplicatingIds((prev) => {
        const next = new Set(prev);
        next.delete(workflowId);
        return next;
      });
    }
  }

  async function handleUseInWorkflow(
    protocolDef: ProtocolDefinition,
    action: ProtocolAction
  ): Promise<void> {
    setCreatingActionSlug(action.slug);

    try {
      if (!session) {
        await authClient.signIn.anonymous();
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      const actionTypeId = `${protocolDef.slug}/${action.slug}`;
      const actionLabel = `${protocolDef.name}: ${action.label}`;

      const protocolMeta = JSON.stringify({
        protocolSlug: protocolDef.slug,
        contractKey: action.contract,
        functionName: action.function,
        actionType: action.type,
      });

      const triggerId = nanoid();
      const actionId = nanoid();
      const edgeId = nanoid();

      const nodes = [
        {
          id: triggerId,
          type: "trigger" as const,
          position: { x: 0, y: 0 },
          data: {
            label: "",
            description: "",
            type: "trigger" as const,
            config: { triggerType: "Manual" },
            status: "idle" as const,
          },
        },
        {
          id: actionId,
          type: "action" as const,
          position: { x: 272, y: 0 },
          selected: true,
          data: {
            label: actionLabel,
            description: "",
            type: "action" as const,
            config: {
              actionType: actionTypeId,
              _protocolMeta: protocolMeta,
            },
            status: "idle" as const,
          },
        },
      ];

      const edges = [
        { id: edgeId, source: triggerId, target: actionId, type: "animated" },
      ];

      const newWorkflow = await api.workflow.create({
        name: "Untitled Workflow",
        description: "",
        nodes,
        edges,
      });

      refetchSidebar();
      sessionStorage.setItem("animate-sidebar", "true");
      router.push(`/workflows/${newWorkflow.id}`);
    } catch {
      toast.error("Failed to create workflow");
      setCreatingActionSlug(null);
    }
  }

  async function handleListenToEvent(
    protocolDef: ProtocolDefinition,
    event: ProtocolEvent
  ): Promise<void> {
    setCreatingEventSlug(event.slug);

    try {
      if (!session) {
        await authClient.signIn.anonymous();
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      const triggerId = nanoid();

      const nodes = [
        {
          id: triggerId,
          type: "trigger" as const,
          position: { x: 0, y: 0 },
          data: {
            label: `${protocolDef.name}: ${event.label}`,
            description: event.description,
            type: "trigger" as const,
            config: {
              triggerType: "Event",
              eventName: event.eventName,
              contractABI: buildEventAbiFragment(event),
              _eventProtocolSlug: protocolDef.slug,
              _eventSlug: event.slug,
              _eventProtocolIconPath: protocolDef.icon ?? "",
            },
            status: "idle" as const,
          },
        },
      ];

      const newWorkflow = await api.workflow.create({
        name: "Untitled Workflow",
        description: "",
        nodes,
        edges: [],
      });

      refetchSidebar();
      sessionStorage.setItem("animate-sidebar", "true");
      router.push(`/workflows/${newWorkflow.id}`);
    } catch {
      toast.error("Failed to create workflow");
      setCreatingEventSlug(null);
    }
  }

  const firstContract = Object.values(protocol.contracts)[0];
  const firstChainEntry = firstContract
    ? Object.entries(firstContract.addresses)[0]
    : undefined;
  const explorerUrl =
    firstChainEntry?.[0] && firstChainEntry[1]
      ? getExplorerUrl(firstChainEntry[0], firstChainEntry[1])
      : null;

  return (
    <div>
      {!hideBackButton && onBack && (
        <Button
          className="mb-6 text-muted-foreground hover:text-foreground"
          onClick={onBack}
          variant="ghost"
        >
          <ArrowLeft className="mr-2 size-4" />
          Back to Protocols
        </Button>
      )}

      <div className="flex items-start gap-4">
        <div className="flex size-12 shrink-0 items-center justify-center rounded-lg bg-[var(--color-hub-icon-bg)]">
          {protocol.icon ? (
            <Image
              alt={protocol.name}
              className="rounded"
              height={32}
              src={protocol.icon}
              width={32}
            />
          ) : (
            <Box className="size-5 text-[var(--color-text-accent)]" />
          )}
        </div>
        <div>
          <div className="flex items-center gap-2">
            <h2 className="font-bold text-2xl">{protocol.name}</h2>
            {explorerUrl && (
              <a
                className="text-muted-foreground hover:text-foreground transition-colors"
                href={explorerUrl}
                rel="noopener noreferrer"
                target="_blank"
                title="View on explorer"
              >
                <ExternalLink className="size-4" />
              </a>
            )}
            {modalUrl && (
              <Link
                className="inline-flex items-center gap-1 rounded-md bg-muted/50 px-2 py-0.5 text-muted-foreground text-xs transition-colors hover:bg-muted hover:text-foreground"
                href={modalUrl}
              >
                View as modal
                <ArrowUpRight className="size-3" />
              </Link>
            )}
          </div>
          <p className="mt-1 text-muted-foreground text-sm">
            {protocol.description}
          </p>
          <div className="mt-3 flex flex-wrap gap-1">
            {allChains.map((chain) => (
              <span
                className="rounded-full bg-[var(--color-bg-accent)] px-2 py-0.5 font-medium text-[var(--color-text-accent)] text-[10px]"
                key={chain}
              >
                {getChainName(chain)}
              </span>
            ))}
          </div>
        </div>
      </div>

      <Tabs className="mt-6" defaultValue="actions" onValueChange={onTabChange}>
        <TabsList className="mb-4 h-auto w-full justify-start gap-4 rounded-none border-b border-border/30 bg-transparent p-0">
          <TabsTrigger className={TAB_TRIGGER_CLASS} value="actions">
            Actions ({protocol.actions.length})
          </TabsTrigger>
          {protocol.events && protocol.events.length > 0 && (
            <TabsTrigger className={TAB_TRIGGER_CLASS} value="events">
              Events ({protocol.events.length})
            </TabsTrigger>
          )}
          <TabsTrigger className={TAB_TRIGGER_CLASS} value="workflows">
            Workflows ({featuredWorkflows.length})
          </TabsTrigger>
        </TabsList>

        <TabsContent value="actions">
          <div>
            {protocol.actions.map((action, index) => (
              <ActionRow
                action={action}
                isCreating={creatingActionSlug === action.slug}
                isLast={index === protocol.actions.length - 1}
                key={action.slug}
                onUse={() => handleUseInWorkflow(protocol, action)}
              />
            ))}
          </div>
        </TabsContent>

        {protocol.events && protocol.events.length > 0 && (
          <TabsContent value="events">
            <div>
              {protocol.events.map((event, index) => (
                <EventRow
                  event={event}
                  isCreating={creatingEventSlug === event.slug}
                  isLast={index === (protocol.events?.length ?? 0) - 1}
                  key={event.slug}
                  onListen={() => handleListenToEvent(protocol, event)}
                />
              ))}
            </div>
          </TabsContent>
        )}

        <TabsContent value="workflows">
          {featuredWorkflows.length > 0 ? (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {featuredWorkflows.map((workflow) => (
                <WorkflowTemplateCard
                  isDuplicating={duplicatingIds.has(workflow.id)}
                  key={workflow.id}
                  onDuplicate={(e) => {
                    e.stopPropagation();
                    handleDuplicate(workflow.id);
                  }}
                  onPreview={(e) => {
                    e.stopPropagation();
                    router.push(`/workflows/${workflow.id}`);
                  }}
                  workflow={workflow}
                />
              ))}
            </div>
          ) : (
            <p className="py-8 text-center text-muted-foreground text-sm">
              No workflows available for this protocol yet.
            </p>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
