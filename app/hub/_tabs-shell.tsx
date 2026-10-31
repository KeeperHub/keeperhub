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

// TabsTrigger's dark: picked fill outranks a plain one, so the hub fill is set
// both ways; its focus border gives way to the hub focus ring.
const PILL_CLASSES =
  "inline-flex min-h-9 items-center gap-2 rounded-full px-2 py-2 text-sm font-normal @max-xl/hub-band:gap-1.5 text-muted-foreground transition-colors duration-150 ease hover:bg-[var(--color-hub-icon-bg)]/40 hover:text-foreground dark:hover:text-foreground focus-visible:hub-focus-ring focus-visible:ring-offset-sidebar focus-visible:border-transparent data-[state=active]:bg-[var(--color-hub-icon-bg)] dark:data-[state=active]:bg-[var(--color-hub-icon-bg)] data-[state=active]:font-semibold data-[state=active]:text-foreground motion-reduce:transition-none @xl/hub-band:px-4";

const PILL_ICON_CLASSES =
  "size-4 text-muted-foreground group-data-[state=active]:text-[var(--color-text-accent)] max-xs:hidden";

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
    // The band follows its own width rather than the window's: the nav takes
    // a varying share beside it, up to a 1024px window leaving it 640px.
    <Tabs
      className="@container/hub-band w-full"
      onValueChange={handleChange}
      value={initialTab}
    >
      {/* Under 36rem the band is search and links, then the tabs sharing a
          row equally; under 48rem the tabs keep a row of their own; from
          48rem it is the single row it always was, the links last. The
          links are rendered in both places and only one shows, so in every
          layout the DOM, and with it Tab, follows the order drawn. */}
      <div className="mb-6 flex flex-wrap items-center gap-x-4 gap-y-2 border-border/20 border-b py-2 @3xl/hub-band:flex-nowrap">
        {searchSlot}
        {actionsSlot ? (
          <div className="ml-auto flex self-stretch @xl/hub-band:block @xl/hub-band:self-auto @3xl/hub-band:hidden">
            {actionsSlot}
          </div>
        ) : null}
        <TabsList
          aria-label="Hub views"
          className="grid h-auto w-full grid-cols-3 items-center justify-start gap-1 bg-transparent p-0 @xl/hub-band:grid-cols-[repeat(3,max-content)] @3xl/hub-band:inline-flex @3xl/hub-band:w-fit"
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
        {actionsSlot ? (
          <div className="ml-auto hidden @3xl/hub-band:block">
            {actionsSlot}
          </div>
        ) : null}
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
