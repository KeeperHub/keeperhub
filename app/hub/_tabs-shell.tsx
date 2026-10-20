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
  "inline-flex min-h-9 items-center gap-2 rounded-full px-2 py-2 text-sm font-normal max-sm:gap-1.5 text-muted-foreground/70 transition-colors duration-150 ease hover:bg-[var(--color-hub-icon-bg)]/40 hover:text-foreground focus-visible:ring-2 focus-visible:ring-[var(--color-border-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-hub-overlay)] data-[state=active]:bg-[var(--color-hub-icon-bg)] data-[state=active]:font-semibold data-[state=active]:text-foreground data-[state=active]:hover:bg-[var(--color-hub-icon-bg)] motion-reduce:transition-none sm:px-4";

const PILL_ICON_CLASSES =
  "size-4 text-muted-foreground/50 group-data-[state=active]:text-[var(--color-text-accent)] max-xs:hidden";

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
      {/* Below lg the tabs take a row of their own under the search box and
          the links, sharing its width equally on phones; from lg the band is
          the single row it always was. The tabs stay second in the DOM so
          desktop focus order is unchanged; below lg, reading-flow makes Tab
          follow the rows as drawn where browsers support it. */}
      <div className="mb-6 flex flex-wrap items-center gap-x-4 gap-y-2 border-border/20 border-b py-2 max-lg:[reading-flow:flex-visual] lg:flex-nowrap">
        {searchSlot}
        <TabsList
          aria-label="Hub views"
          className="order-last grid h-auto w-full grid-cols-3 items-center justify-start gap-1 bg-transparent p-0 sm:grid-cols-[repeat(3,max-content)] lg:order-none lg:inline-flex lg:w-fit"
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
          <div className="ml-auto flex self-stretch sm:block sm:self-auto">
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
