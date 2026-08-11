"use client";

import {
  ChevronRight,
  Eye,
  EyeOff,
  Gem,
  Grid3X3,
  List,
  MoreHorizontal,
  Search,
  Settings,
  Zap,
} from "lucide-react";
import { useAtomValue } from "jotai";
import { useEffect, useMemo, useRef, useState } from "react";
import { FeatureUpgradeDialog } from "@/components/billing/feature-upgrade-dialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { IntegrationIcon } from "@/components/ui/integration-icon";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useFeatures } from "@/hooks/use-features";
import { useIsTouch } from "@/hooks/use-touch";
import type { FeatureDefinition } from "@/lib/features";
import { resolveActionFeature } from "@/lib/features";
import { cn } from "@/lib/utils";
import { filterActionsByAvailableChainTypes } from "@/lib/workflow/action-chain-availability";
import { nodesAtom } from "@/lib/workflow/store";
import { getAllActions } from "@/plugins/registry";

type ActionType = {
  id: string;
  label: string;
  description: string;
  category: string;
  integration?: string;
};

// System actions that don't have plugins
const SYSTEM_ACTIONS: ActionType[] = [
  {
    id: "HTTP Request",
    label: "HTTP Request",
    description: "Make an HTTP request to any API",
    category: "System",
  },
  {
    id: "Database Query",
    label: "Database Query",
    description: "Query your database",
    category: "System",
  },
  {
    id: "Condition",
    label: "Condition",
    description: "Branch based on a condition",
    category: "System",
  },
  {
    id: "For Each",
    label: "For Each",
    description: "Loop over an array from a previous step",
    category: "System",
  },
  {
    id: "Collect",
    label: "Collect",
    description: "Gather results from a For Each loop",
    category: "System",
  },
];

/**
 * The set of chain types (e.g. "evm", "solana") that have at least one enabled
 * chain, from /api/chains. Returns undefined while loading or on failure so the
 * palette falls back to showing every action (fail open). Server-only env flags
 * cannot gate the client palette, so chain availability is the client-safe
 * signal for whether a chain-type-specific node (e.g. Solana-only) should show.
 */
function useEnabledChainTypes(): ReadonlySet<string> | undefined {
  const [chainTypes, setChainTypes] = useState<ReadonlySet<string> | undefined>(
    undefined
  );

  useEffect(() => {
    let cancelled = false;
    fetch("/api/chains")
      .then((res) =>
        res.ok ? res.json() : Promise.reject(new Error(`chains ${res.status}`))
      )
      .then((data: { chainType?: string }[]) => {
        if (!cancelled) {
          setChainTypes(
            new Set(
              data
                .map((chain) => chain.chainType)
                .filter((type): type is string => Boolean(type))
            )
          );
        }
      })
      .catch(() => {
        // Fail open: leave undefined so useAllActions shows every action.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return chainTypes;
}

// Combine System actions with plugin actions
function useAllActions(): ActionType[] {
  const nodes = useAtomValue(nodesAtom);
  const hasForEach = nodes.some(
    (n) => n.data?.config?.actionType === "For Each"
  );
  const enabledChainTypes = useEnabledChainTypes();

  return useMemo(() => {
    // Hide nodes restricted to a chain type with no enabled chains (e.g. the
    // Solana-only Transfer SPL Token node when Solana is off). While chain types
    // are still loading, show all.
    const pluginActions = enabledChainTypes
      ? filterActionsByAvailableChainTypes(getAllActions(), enabledChainTypes)
      : getAllActions();

    const mappedPluginActions: ActionType[] = pluginActions.map((action) => ({
      id: action.id,
      label: action.label,
      description: action.description,
      category: action.category,
      integration: action.integration,
    }));

    const systemActions = hasForEach
      ? SYSTEM_ACTIONS
      : SYSTEM_ACTIONS.filter((a) => a.id !== "Collect");

    return [...systemActions, ...mappedPluginActions];
  }, [hasForEach, enabledChainTypes]);
}

type ActionGridProps = {
  onSelectAction: (actionType: string) => void;
  disabled?: boolean;
  isNewlyCreated?: boolean;
};

function GroupIcon({
  group,
}: {
  group: { category: string; actions: ActionType[] };
}) {
  // For plugin categories, use the integration icon from the first action
  const firstAction = group.actions[0];
  if (firstAction?.integration) {
    return (
      <IntegrationIcon
        className="size-4"
        integration={firstAction.integration}
      />
    );
  }
  // For System category
  if (group.category === "System") {
    return <Settings className="size-4" />;
  }
  return <Zap className="size-4" />;
}

function ActionIcon({
  action,
  className,
}: {
  action: ActionType;
  className?: string;
}) {
  if (action.integration) {
    return (
      <IntegrationIcon className={className} integration={action.integration} />
    );
  }
  if (action.category === "System") {
    return <Settings className={cn(className, "text-muted-foreground")} />;
  }
  return <Zap className={cn(className, "text-muted-foreground")} />;
}

// Local storage keys
const HIDDEN_GROUPS_KEY = "workflow-action-grid-hidden-groups";
const VIEW_MODE_KEY = "workflow-action-grid-view-mode";

type ViewMode = "list" | "grid";

function getInitialHiddenGroups(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const stored = localStorage.getItem(HIDDEN_GROUPS_KEY);
    return stored ? new Set(JSON.parse(stored)) : new Set();
  } catch {
    return new Set();
  }
}

function getInitialViewMode(): ViewMode {
  if (typeof window === "undefined") return "list";
  try {
    const stored = localStorage.getItem(VIEW_MODE_KEY);
    return stored === "grid" ? "grid" : "list";
  } catch {
    return "list";
  }
}

// Super-category definitions for the action panel
const SUPER_CATEGORY_ORDER = ["Web3", "Messaging", "System"] as const;
type SuperCategory = (typeof SUPER_CATEGORY_ORDER)[number];

const MESSAGING_CATEGORIES: ReadonlySet<string> = new Set([
  "Discord",
  "Email",
  "Slack",
  "Telegram",
]);
const SYSTEM_CATEGORIES: ReadonlySet<string> = new Set([
  "System",
  "Code",
  "Math",
  "Webhook",
]);

function getSuperCategory(category: string): SuperCategory {
  if (SYSTEM_CATEGORIES.has(category)) {
    return "System";
  }
  if (MESSAGING_CATEGORIES.has(category)) {
    return "Messaging";
  }
  return "Web3";
}

type PluginGroup = { category: string; actions: ActionType[] };
type SuperCategoryGroup = {
  superCategory: SuperCategory;
  pluginGroups: PluginGroup[];
};

export function ActionGrid({
  onSelectAction,
  disabled,
  isNewlyCreated,
}: ActionGridProps) {
  const actions = useAllActions();
  const { snapshot: featureSnapshot } = useFeatures();
  const [upgradeFeature, setUpgradeFeature] = useState<FeatureDefinition | null>(
    null
  );
  const [filter, setFilter] = useState("");
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(
    () => new Set(actions.map((a) => a.category))
  );
  const [collapsedSuperCategories, setCollapsedSuperCategories] = useState<
    Set<SuperCategory>
  >(() => new Set());
  const [hiddenGroups, setHiddenGroups] = useState<Set<string>>(
    getInitialHiddenGroups
  );
  const [showHidden, setShowHidden] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>(getInitialViewMode);
  const inputRef = useRef<HTMLInputElement>(null);
  const isTouch = useIsTouch();

  // Returns the gating info for a given action id (the actionType stored on
  // saved workflow nodes). `feature` is undefined for non-gated actions; for
  // gated actions, `enabled` reflects whether the org's plan unlocks it.
  const getGate = (
    actionId: string
  ): { feature: FeatureDefinition | undefined; enabled: boolean } => {
    const feature = resolveActionFeature(actionId);
    if (!feature) {
      return { feature: undefined, enabled: true };
    }
    // While the snapshot is loading, treat gated actions as locked to avoid
    // a flash of enabled state. Free users see the lock immediately; paid
    // users see it for a few hundred ms until the fetch completes.
    const enabled = featureSnapshot?.enabledFeatureIds.includes(feature.id) ?? false;
    return { feature, enabled };
  };

  const handleActionClick = (actionId: string): void => {
    if (disabled) {
      return;
    }
    const gate = getGate(actionId);
    if (gate.feature && !gate.enabled) {
      setUpgradeFeature(gate.feature);
      return;
    }
    onSelectAction(actionId);
  };

  const toggleViewMode = () => {
    const newMode = viewMode === "list" ? "grid" : "list";
    setViewMode(newMode);
    localStorage.setItem(VIEW_MODE_KEY, newMode);
  };

  const toggleGroup = (category: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(category)) {
        next.delete(category);
      } else {
        next.add(category);
      }
      return next;
    });
  };

  const toggleSuperCategory = (sc: SuperCategory): void => {
    setCollapsedSuperCategories((prev) => {
      const next = new Set(prev);
      if (next.has(sc)) {
        next.delete(sc);
      } else {
        next.add(sc);
      }
      return next;
    });
  };

  const toggleHideGroup = (category: string) => {
    setHiddenGroups((prev) => {
      const next = new Set(prev);
      if (next.has(category)) {
        next.delete(category);
      } else {
        next.add(category);
      }
      // Persist to localStorage
      localStorage.setItem(HIDDEN_GROUPS_KEY, JSON.stringify([...next]));
      return next;
    });
  };

  useEffect(() => {
    // Only focus after touch detection is complete (isTouch !== undefined)
    // and only on non-touch devices to avoid opening the keyboard
    if (isNewlyCreated && isTouch === false && inputRef.current) {
      inputRef.current.focus();
    }
  }, [isNewlyCreated, isTouch]);

  const filteredActions = actions.filter((action) => {
    const searchTerm = filter.toLowerCase();
    return (
      action.label.toLowerCase().includes(searchTerm) ||
      action.description.toLowerCase().includes(searchTerm) ||
      action.category.toLowerCase().includes(searchTerm)
    );
  });

  // Group actions by super-category, then by plugin category within each
  const superCategoryGroups = useMemo((): SuperCategoryGroup[] => {
    const categoryMap: Record<string, ActionType[]> = {};

    for (const action of filteredActions) {
      if (!categoryMap[action.category]) {
        categoryMap[action.category] = [];
      }
      categoryMap[action.category].push(action);
    }

    const superMap: Record<SuperCategory, PluginGroup[]> = {
      Web3: [],
      Messaging: [],
      System: [],
    };

    const sortedCategories = Object.keys(categoryMap).sort((a, b) => {
      if (a === "Web3") return -1;
      if (b === "Web3") return 1;
      return a.localeCompare(b);
    });

    for (const category of sortedCategories) {
      const sc = getSuperCategory(category);
      superMap[sc].push({ category, actions: categoryMap[category] });
    }

    return SUPER_CATEGORY_ORDER.map((sc) => ({
      superCategory: sc,
      pluginGroups: superMap[sc],
    })).filter((g) => g.pluginGroups.length > 0);
  }, [filteredActions]);

  // Filter groups based on hidden state
  const visibleSuperGroups = useMemo((): SuperCategoryGroup[] => {
    if (showHidden) {
      return superCategoryGroups;
    }
    return superCategoryGroups
      .map((sg) => ({
        ...sg,
        pluginGroups: sg.pluginGroups.filter(
          (pg) => !hiddenGroups.has(pg.category)
        ),
      }))
      .filter((sg) => sg.pluginGroups.length > 0);
  }, [superCategoryGroups, hiddenGroups, showHidden]);

  const hiddenCount = hiddenGroups.size;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex shrink-0 gap-2">
        <div className="relative flex-1">
          <Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="pl-9"
            data-testid="action-search-input"
            disabled={disabled}
            id="action-filter"
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Search actions..."
            ref={inputRef}
            value={filter}
          />
        </div>
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                className="shrink-0"
                onClick={toggleViewMode}
                size="icon"
                variant="ghost"
              >
                {viewMode === "list" ? (
                  <Grid3X3 className="size-4" />
                ) : (
                  <List className="size-4" />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {viewMode === "list" ? "Grid view" : "List view"}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
        {hiddenCount > 0 && (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  className={cn("shrink-0", showHidden && "bg-muted")}
                  onClick={() => setShowHidden(!showHidden)}
                  size="icon"
                  variant="ghost"
                >
                  {showHidden ? (
                    <Eye className="size-4" />
                  ) : (
                    <EyeOff className="size-4" />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                {showHidden
                  ? "Hide hidden groups"
                  : `Show ${hiddenCount} hidden group${hiddenCount > 1 ? "s" : ""}`}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}
      </div>

      <div
        className="min-h-0 flex-1 overflow-y-auto pb-4"
        data-testid="action-grid"
      >
        {filteredActions.length === 0 && (
          <p className="py-4 text-center text-muted-foreground text-sm">
            No actions found
          </p>
        )}
        {filteredActions.length > 0 && visibleSuperGroups.length === 0 && (
          <p className="py-4 text-center text-muted-foreground text-sm">
            All groups are hidden
          </p>
        )}

        {/* Grid View */}
        {viewMode === "grid" && visibleSuperGroups.length > 0 && (
          <div
            className="grid gap-2 p-1"
            style={{
              gridTemplateColumns: "repeat(auto-fill, minmax(72px, 1fr))",
            }}
          >
            {filteredActions
              .filter(
                (action) => showHidden || !hiddenGroups.has(action.category)
              )
              .map((action) => {
                const gate = getGate(action.id);
                const isLocked = Boolean(gate.feature && !gate.enabled);
                return (
                  <button
                    className={cn(
                      "relative flex aspect-square flex-col items-center justify-center gap-1.5 rounded-lg border border-transparent p-2 text-center transition-colors hover:border-border hover:bg-muted",
                      disabled && "pointer-events-none opacity-50",
                      isLocked && "opacity-60"
                    )}
                    data-locked={isLocked ? "true" : undefined}
                    data-testid={`action-option-${action.id.toLowerCase().replace(/\s+/g, "-")}`}
                    disabled={disabled}
                    key={action.id}
                    onClick={() => handleActionClick(action.id)}
                    title={
                      isLocked && gate.feature
                        ? `${gate.feature.name} requires ${gate.feature.requiredPlan}`
                        : undefined
                    }
                    type="button"
                  >
                    {isLocked && (
                      <Gem className="absolute top-1 right-1 size-3 text-[var(--color-text-accent)]" />
                    )}
                    <ActionIcon action={action} className="size-6" />
                    <span className="line-clamp-2 font-medium text-xs leading-tight">
                      {action.label}
                    </span>
                  </button>
                );
              })}
          </div>
        )}

        {/* List View - Flat search results (no category headers) */}
        {viewMode === "list" &&
          filter &&
          filteredActions.length > 0 &&
          filteredActions
            .filter(
              (action) => showHidden || !hiddenGroups.has(action.category)
            )
            .map((action) => {
              const gate = getGate(action.id);
              const isLocked = Boolean(gate.feature && !gate.enabled);
              return (
                <button
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors hover:bg-muted",
                    disabled && "pointer-events-none opacity-50",
                    isLocked && "opacity-60"
                  )}
                  data-locked={isLocked ? "true" : undefined}
                  data-testid={`action-option-${action.id.toLowerCase().replace(/\s+/g, "-")}`}
                  disabled={disabled}
                  key={action.id}
                  onClick={() => handleActionClick(action.id)}
                  title={
                    isLocked && gate.feature
                      ? `${gate.feature.name} requires ${gate.feature.requiredPlan}`
                      : undefined
                  }
                  type="button"
                >
                  <ActionIcon action={action} className="size-4 shrink-0" />
                  <span className="min-w-0 flex-1 truncate">
                    <span className="font-medium">{action.label}</span>
                    {action.description && (
                      <span className="text-muted-foreground text-xs">
                        {" "}
                        - {action.description}
                      </span>
                    )}
                  </span>
                  {isLocked && (
                    <Gem className="size-3.5 shrink-0 text-[var(--color-text-accent)]" />
                  )}
                </button>
              );
            })}

        {/* List View - Grouped by super-category */}
        {viewMode === "list" &&
          !filter &&
          visibleSuperGroups.length > 0 &&
          visibleSuperGroups.map((sg, sgIndex) => (
            <div key={sg.superCategory}>
              {/* Super-category header */}
              <button
                className={cn(
                  "flex w-full items-center gap-2 px-3 pb-1.5 transition-opacity hover:opacity-80",
                  sgIndex === 0 ? "pt-1" : "pt-4"
                )}
                onClick={() => toggleSuperCategory(sg.superCategory)}
                type="button"
              >
                <div className="h-px flex-1 bg-border/40" />
                <span className="shrink-0 text-[10px] font-medium uppercase tracking-widest text-emerald-500/80">
                  {sg.superCategory}
                </span>
                <div className="h-px flex-1 bg-border/40" />
              </button>

              {/* Plugin groups within super-category */}
              {!collapsedSuperCategories.has(sg.superCategory) &&
              sg.pluginGroups.map((group, groupIndex) => {
                const isCollapsed = collapsedGroups.has(group.category);
                const isHidden = hiddenGroups.has(group.category);
                return (
                  <div key={group.category}>
                    {groupIndex > 0 && (
                      <div className="my-2 h-px bg-border" />
                    )}
                    <div
                      className={cn(
                        "sticky top-0 z-10 mb-1 flex items-center gap-2 bg-background px-3 py-2 font-medium text-muted-foreground text-xs uppercase tracking-wider",
                        isHidden && "opacity-50"
                      )}
                    >
                      <button
                        className="flex flex-1 items-center gap-2 text-left hover:text-foreground"
                        data-testid={`action-group-${group.category
                          .toLowerCase()
                          .replace(/\s+/g, "-")}`}
                        onClick={() => toggleGroup(group.category)}
                        type="button"
                      >
                        <ChevronRight
                          className={cn(
                            "size-3.5 transition-transform",
                            !isCollapsed && "rotate-90"
                          )}
                        />
                        <GroupIcon group={group} />
                        {group.category}
                      </button>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <button
                            className="rounded p-0.5 hover:bg-muted hover:text-foreground"
                            type="button"
                          >
                            <MoreHorizontal className="size-4" />
                          </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem
                            onClick={() => toggleHideGroup(group.category)}
                          >
                            {isHidden ? (
                              <>
                                <Eye className="mr-2 size-4" />
                                Show group
                              </>
                            ) : (
                              <>
                                <EyeOff className="mr-2 size-4" />
                                Hide group
                              </>
                            )}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                    {!isCollapsed &&
                      group.actions.map((action) => {
                        const gate = getGate(action.id);
                        const isLocked = Boolean(
                          gate.feature && !gate.enabled
                        );
                        return (
                          <button
                            className={cn(
                              "flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors hover:bg-muted",
                              disabled && "pointer-events-none opacity-50",
                              isLocked && "opacity-60"
                            )}
                            data-locked={isLocked ? "true" : undefined}
                            data-testid={`action-option-${action.id.toLowerCase().replace(/\s+/g, "-")}`}
                            disabled={disabled}
                            key={action.id}
                            onClick={() => handleActionClick(action.id)}
                            title={
                              isLocked && gate.feature
                                ? `${gate.feature.name} requires ${gate.feature.requiredPlan}`
                                : undefined
                            }
                            type="button"
                          >
                            <span className="min-w-0 flex-1 truncate">
                              <span className="font-medium">
                                {action.label}
                              </span>
                              {action.description && (
                                <span className="text-muted-foreground text-xs">
                                  {" "}
                                  - {action.description}
                                </span>
                              )}
                            </span>
                            {isLocked && (
                              <Gem className="size-3.5 shrink-0 text-[var(--color-text-accent)]" />
                            )}
                          </button>
                        );
                      })}
                  </div>
                );
              })}
            </div>
          ))}
      </div>
      <FeatureUpgradeDialog
        feature={upgradeFeature}
        onOpenChange={(open) => {
          if (!open) {
            setUpgradeFeature(null);
          }
        }}
        open={upgradeFeature !== null}
      />
    </div>
  );
}
