"use client";

import { ChevronLeft, ChevronRight, Eye } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { api, type SavedWorkflow } from "@/lib/api-client";
import { authClient, useSession } from "@/lib/auth-client";
import { refetchSidebar } from "@/lib/refetch-sidebar";
import { WorkflowMiniMap } from "./workflow-mini-map";
import { WorkflowNodeIcons } from "./workflow-node-icons";

type FeaturedCarouselProps = {
  workflows: SavedWorkflow[];
};

export function FeaturedCarousel({ workflows }: FeaturedCarouselProps) {
  const router = useRouter();
  const { data: session } = useSession();
  const [duplicatingIds, setDuplicatingIds] = useState<Set<string>>(new Set());
  const scrollRef = useRef<HTMLDivElement>(null);

  const arrowVisibility = useMemo((): string => {
    const count = workflows.length;
    if (count > 4) {
      return "flex";
    }
    if (count > 3) {
      return "flex lg:hidden";
    }
    if (count > 2) {
      return "flex md:hidden";
    }
    if (count > 1) {
      return "flex sm:hidden";
    }
    return "hidden";
  }, [workflows.length]);

  const scroll = useCallback((direction: "left" | "right") => {
    const container = scrollRef.current;
    if (!container) {
      return;
    }
    const cardWidth = 280;
    const gap = 16;
    const scrollAmount = cardWidth + gap;
    container.scrollBy({
      left: direction === "left" ? -scrollAmount : scrollAmount,
      behavior: "smooth",
    });
  }, []);

  const handleDuplicate = async (workflowId: string): Promise<void> => {
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
      console.error("Failed to duplicate workflow:", error);
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
  };

  if (workflows.length === 0) {
    return null;
  }

  return (
    <section aria-label="Featured workflows" className="relative z-10">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="font-bold text-2xl">Featured</h2>
        <div className={`gap-2 ${arrowVisibility}`}>
          <Button
            aria-label="Scroll left"
            onClick={() => scroll("left")}
            size="icon"
            variant="outline"
          >
            <ChevronLeft className="size-4" />
          </Button>
          <Button
            aria-label="Scroll right"
            onClick={() => scroll("right")}
            size="icon"
            variant="outline"
          >
            <ChevronRight className="size-4" />
          </Button>
        </div>
      </div>

      <div className="relative">
        <div
          className="flex gap-4 overflow-x-auto scroll-smooth motion-reduce:scroll-auto [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          ref={scrollRef}
        >
          {workflows.map((workflow) => {
            const isDuplicating = duplicatingIds.has(workflow.id);

            return (
              <Card
                className="flex w-[280px] shrink-0 flex-col gap-0 overflow-hidden border-none bg-sidebar py-0 transition-colors motion-reduce:transition-none"
                key={workflow.id}
              >
                <div className="relative flex h-[140px] w-full items-center justify-center overflow-hidden px-8">
                  <WorkflowMiniMap
                    edges={workflow.edges}
                    height={130}
                    nodes={workflow.nodes}
                    width={240}
                  />
                </div>
                <CardHeader className="pb-2">
                  <CardTitle className="line-clamp-2">
                    {workflow.name}
                  </CardTitle>
                  {workflow.description && (
                    <CardDescription className="line-clamp-2">
                      {workflow.description}
                    </CardDescription>
                  )}
                  <WorkflowNodeIcons nodes={workflow.nodes} />
                </CardHeader>
                <div className="flex-1" />
                <CardFooter className="gap-2 pb-3">
                  <Button
                    className="flex-1"
                    disabled={isDuplicating}
                    onClick={() => handleDuplicate(workflow.id)}
                    variant="default"
                  >
                    {isDuplicating ? "Duplicating..." : "Use Template"}
                  </Button>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        aria-label="View template"
                        onClick={() => router.push(`/workflows/${workflow.id}`)}
                        variant="outline"
                      >
                        <Eye className="size-4" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="top">View Template</TooltipContent>
                  </Tooltip>
                </CardFooter>
              </Card>
            );
          })}
        </div>
        <div className="pointer-events-none absolute inset-y-0 right-0 w-16 bg-gradient-to-l from-[var(--color-hub-overlay)] to-transparent" />
      </div>
    </section>
  );
}
