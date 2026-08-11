"use client";

import { ArrowLeft, Check, ChevronRight, ListFilter } from "lucide-react";
import { useState } from "react";
import { ActorIdentity } from "@/components/activity/actor-avatar";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  ACTIVITY_TYPE_OPTIONS,
  ALL,
  DATE_PRESET_OPTIONS,
  FILTER_DIMENSIONS,
  type FilterDimension,
  type useAuditActivity,
} from "@/lib/hooks/use-audit-activity";

type Activity = ReturnType<typeof useAuditActivity>;

type Option = {
  value: string;
  label: string;
  search: string;
  node?: React.ReactNode;
};

/**
 * A single dimension's options plus its current selection. `multi` dimensions
 * toggle values (AND-combined in the feed query); the `date` dimension is
 * single-select and falls back to the ALL sentinel.
 */
type DimensionModel = {
  options: Option[];
  selected: string[];
  multi: boolean;
  toggle: (value: string) => void;
  clear: () => void;
  count: number;
};

function buildModel(activity: Activity, id: FilterDimension): DimensionModel {
  if (id === "person") {
    return {
      multi: true,
      selected: activity.people,
      count: activity.people.length,
      options: activity.members.map((m) => ({
        value: m.userId,
        label: m.name || m.email || m.userId,
        search: `${m.name ?? ""} ${m.email ?? ""} ${m.role ?? ""}`,
        node: (
          <ActorIdentity
            actor={{
              id: m.userId,
              name: m.name,
              email: m.email,
              role: m.role,
              image: m.image,
            }}
          />
        ),
      })),
      toggle: (v) =>
        activity.setPeople(activity.toggleValue(activity.people, v)),
      clear: () => activity.setPeople([]),
    };
  }
  if (id === "activity") {
    return {
      multi: true,
      selected: activity.types,
      count: activity.types.length,
      options: ACTIVITY_TYPE_OPTIONS.map((o) => ({
        value: o.value,
        label: o.label,
        search: o.label,
      })),
      toggle: (v) => activity.setTypes(activity.toggleValue(activity.types, v)),
      clear: () => activity.setTypes([]),
    };
  }
  if (id === "project") {
    return {
      multi: true,
      selected: activity.projects,
      count: activity.projects.length,
      options: activity.projectOptions.map((o) => ({
        value: o.id,
        label: o.label,
        search: o.label,
      })),
      toggle: (v) =>
        activity.setProjects(activity.toggleValue(activity.projects, v)),
      clear: () => activity.setProjects([]),
    };
  }
  if (id === "workflow") {
    return {
      multi: true,
      selected: activity.workflows,
      count: activity.workflows.length,
      options: activity.workflowOptions.map((o) => ({
        value: o.id,
        label: o.label,
        search: o.label,
      })),
      toggle: (v) =>
        activity.setWorkflows(activity.toggleValue(activity.workflows, v)),
      clear: () => activity.setWorkflows([]),
    };
  }
  if (id === "tag") {
    return {
      multi: true,
      selected: activity.tags,
      count: activity.tags.length,
      options: activity.tagOptions.map((o) => ({
        value: o.id,
        label: o.label,
        search: o.label,
      })),
      toggle: (v) => activity.setTags(activity.toggleValue(activity.tags, v)),
      clear: () => activity.setTags([]),
    };
  }
  return {
    multi: false,
    selected: activity.datePreset === ALL ? [] : [activity.datePreset],
    count: activity.datePreset === ALL ? 0 : 1,
    options: DATE_PRESET_OPTIONS.map((o) => ({
      value: o.value,
      label: o.label,
      search: o.label,
    })),
    toggle: (v) => activity.setDatePreset(v),
    clear: () => activity.setDatePreset(ALL),
  };
}

function DimensionList({
  activity,
  onPick,
}: {
  activity: Activity;
  onPick: (id: FilterDimension) => void;
}): React.ReactElement {
  return (
    <CommandList>
      <CommandGroup>
        {FILTER_DIMENSIONS.map((d) => {
          const count = buildModel(activity, d.id).count;
          return (
            <CommandItem
              key={d.id}
              onSelect={() => onPick(d.id)}
              value={d.label}
            >
              <span>{d.label}</span>
              {count > 0 && (
                <span className="ml-auto rounded-full bg-primary/15 px-1.5 py-0.5 text-[10px] text-primary">
                  {count}
                </span>
              )}
              <ChevronRight
                className={
                  count > 0
                    ? "ml-1 size-3.5 opacity-50"
                    : "ml-auto size-3.5 opacity-50"
                }
              />
            </CommandItem>
          );
        })}
      </CommandGroup>
    </CommandList>
  );
}

function ValueList({
  model,
  label,
  onBack,
}: {
  model: DimensionModel;
  label: string;
  onBack: () => void;
}): React.ReactElement {
  return (
    <>
      <div className="flex items-center gap-2 border-b px-2 py-1.5">
        <button
          aria-label="Back to filters"
          className="text-muted-foreground hover:text-foreground"
          onClick={onBack}
          type="button"
        >
          <ArrowLeft className="size-3.5" />
        </button>
        <span className="font-medium text-xs">{label}</span>
        {model.selected.length > 0 && (
          <button
            className="ml-auto text-muted-foreground text-xs hover:text-foreground"
            onClick={model.clear}
            type="button"
          >
            Clear
          </button>
        )}
      </div>
      <CommandInput placeholder={`Search ${label.toLowerCase()}...`} />
      <CommandList>
        <CommandEmpty>No matches</CommandEmpty>
        <CommandGroup>
          {model.options.map((opt) => {
            const checked = model.selected.includes(opt.value);
            return (
              <CommandItem
                key={opt.value}
                onSelect={() => {
                  model.toggle(opt.value);
                  if (!model.multi) {
                    onBack();
                  }
                }}
                value={`${opt.search} ${opt.value}`}
              >
                {opt.node ?? <span>{opt.label}</span>}
                {checked && <Check className="ml-auto size-4 shrink-0" />}
              </CommandItem>
            );
          })}
        </CommandGroup>
      </CommandList>
    </>
  );
}

/**
 * Linear-style activity filter. A single control: one "Filter" button carrying
 * a count of applied values; opening it drills from the dimension list into a
 * searchable value picker, all within one popover. Person resolves to
 * actorUserId, Activity type to resourceType, Project/Workflow/Tag to specific
 * resourceIds, Date to a created-at window (all AND-combined in the feed).
 */
export function AuditFilterBar({
  activity,
}: {
  activity: Activity;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<FilterDimension | null>(null);

  const total = FILTER_DIMENSIONS.reduce(
    (sum, d) => sum + buildModel(activity, d.id).count,
    0
  );

  const clearAll = (): void => {
    activity.setPeople([]);
    activity.setTypes([]);
    activity.setProjects([]);
    activity.setWorkflows([]);
    activity.setTags([]);
    activity.setDatePreset(ALL);
  };

  const activeView = view ? FILTER_DIMENSIONS.find((d) => d.id === view) : null;

  return (
    <Popover
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setView(null);
        }
      }}
      open={open}
    >
      <PopoverTrigger asChild>
        <Button
          className="relative h-8 font-normal text-xs"
          size="sm"
          variant="outline"
        >
          <ListFilter className="mr-1 size-3.5" />
          Filter
          {total > 0 && (
            <span className="-right-1.5 -top-1.5 absolute flex size-4 items-center justify-center rounded-full bg-primary text-[10px] text-primary-foreground">
              {total}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[260px] p-0">
        <Command key={view ?? "root"}>
          {activeView ? (
            <ValueList
              label={activeView.label}
              model={buildModel(activity, activeView.id)}
              onBack={() => setView(null)}
            />
          ) : (
            <>
              <DimensionList activity={activity} onPick={setView} />
              {total > 0 && (
                <>
                  <CommandSeparator />
                  <button
                    className="w-full px-3 py-2 text-left text-muted-foreground text-xs hover:text-foreground"
                    onClick={clearAll}
                    type="button"
                  >
                    Clear all filters
                  </button>
                </>
              )}
            </>
          )}
        </Command>
      </PopoverContent>
    </Popover>
  );
}
