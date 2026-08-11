"use client";

import { Box, Store, Workflow as WorkflowIcon } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { type HubTabValue, isHubTabValue } from "./_tabs-shared";

// Re-export for callers that already import from this file (matches the
// public surface promised in 44-01-PLAN.md acceptance criteria).
export { type HubTabValue, isHubTabValue } from "./_tabs-shared";

type HubTabsShellProps = {
  initialTab: HubTabValue;
  protocolsContent: React.ReactNode;
  workflowsContent: React.ReactNode;
  marketplaceContent: React.ReactNode;
  searchSlot?: React.ReactNode;
  actionsSlot?: React.ReactNode;
};

const PILL_CLASSES =
  "inline-flex min-h-9 items-center gap-2 rounded-full px-4 py-2 text-sm font-normal text-muted-foreground/70 transition-colors duration-150 ease hover:bg-[var(--color-hub-icon-bg)]/40 hover:text-foreground focus-visible:ring-2 focus-visible:ring-[var(--color-border-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-hub-overlay)] data-[state=active]:bg-[var(--color-hub-icon-bg)] data-[state=active]:font-semibold data-[state=active]:text-foreground data-[state=active]:hover:bg-[var(--color-hub-icon-bg)] motion-reduce:transition-none";

const PILL_ICON_CLASSES =
  "size-4 text-muted-foreground/50 group-data-[state=active]:text-[var(--color-text-accent)]";

export function HubTabsShell({
  initialTab,
  protocolsContent,
  workflowsContent,
  marketplaceContent,
  searchSlot,
  actionsSlot,
}: HubTabsShellProps): React.ReactElement {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [, startTransition] = useTransition();

  const handleChange = (value: string): void => {
    if (!isHubTabValue(value)) {
      return;
    }
    const params = new URLSearchParams(searchParams.toString());
    params.set("tab", value);
    // Drop tab-scoped params that don't apply to the destination tab so
    // the URL doesn't carry e.g. `sort=newest` from Marketplace into
    // Workflows. `q` is intentionally preserved (it filters all three
    // tabs); other params are scoped per-tab.
    params.delete("cursor"); // marketplace-only pagination cursor
    if (value !== "marketplace") {
      params.delete("sort");
    }
    // Tag applies to both Workflows and Marketplace (each tab filters
    // its own dataset by the same `public_tags` taxonomy). Drop only
    // when going to Protocols, where there's no tag taxonomy.
    if (value === "protocols") {
      params.delete("tag");
    }
    const qs = params.toString();
    startTransition(() => {
      router.replace(qs ? `/hub?${qs}` : "/hub", { scroll: false });
    });
  };

  return (
    <Tabs className="w-full" onValueChange={handleChange} value={initialTab}>
      <div className="mb-6 flex items-center gap-4 border-border/20 border-b py-2">
        {searchSlot}
        <TabsList
          aria-label="Hub views"
          className="inline-flex h-auto items-center gap-1 bg-transparent p-0"
        >
          <TabsTrigger className={`group ${PILL_CLASSES}`} value="protocols">
            <Box aria-hidden="true" className={PILL_ICON_CLASSES} />
            Protocols
          </TabsTrigger>
          <TabsTrigger className={`group ${PILL_CLASSES}`} value="workflows">
            <WorkflowIcon aria-hidden="true" className={PILL_ICON_CLASSES} />
            Workflows
          </TabsTrigger>
          <TabsTrigger className={`group ${PILL_CLASSES}`} value="marketplace">
            <Store aria-hidden="true" className={PILL_ICON_CLASSES} />
            Marketplace
          </TabsTrigger>
        </TabsList>
        {actionsSlot ? <div className="ml-auto">{actionsSlot}</div> : null}
      </div>

      <TabsContent
        className="mt-0 outline-none transition-opacity duration-100 ease motion-reduce:transition-none"
        tabIndex={0}
        value="protocols"
      >
        {protocolsContent}
      </TabsContent>
      <TabsContent
        className="mt-0 outline-none transition-opacity duration-100 ease motion-reduce:transition-none"
        tabIndex={0}
        value="workflows"
      >
        {workflowsContent}
      </TabsContent>
      <TabsContent
        className="mt-0 outline-none transition-opacity duration-100 ease motion-reduce:transition-none"
        tabIndex={0}
        value="marketplace"
      >
        {marketplaceContent}
      </TabsContent>
    </Tabs>
  );
}
