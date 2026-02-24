"use client";

import { useAtom } from "jotai";
import type { ReactNode } from "react";
import { useCallback } from "react";
import { Button } from "@/components/ui/button";
import type {
  NormalizedStatus,
  RunSource,
} from "@/keeperhub/lib/analytics/types";
import {
  analyticsSourceFilterAtom,
  analyticsStatusFilterAtom,
} from "@/keeperhub/lib/atoms/analytics";
import { cn } from "@/lib/utils";

const STATUS_OPTIONS: Array<{
  value: NormalizedStatus | undefined;
  label: string;
}> = [
  { value: undefined, label: "All" },
  { value: "success", label: "Success" },
  { value: "error", label: "Error" },
  { value: "running", label: "Running" },
  { value: "pending", label: "Pending" },
];

const SOURCE_OPTIONS: Array<{
  value: RunSource | undefined;
  label: string;
}> = [
  { value: undefined, label: "All" },
  { value: "workflow", label: "Workflow" },
  { value: "direct", label: "Direct" },
];

type FilterGroupProps<T> = {
  label: string;
  options: Array<{ value: T; label: string }>;
  current: T;
  onChange: (value: T) => void;
};

function FilterGroup<T>({
  label,
  options,
  current,
  onChange,
}: FilterGroupProps<T>): ReactNode {
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs font-medium text-muted-foreground">
        {label}:
      </span>
      <nav aria-label={label} className="flex items-center gap-1">
        {options.map((option) => (
          <Button
            className={cn(
              "h-7 px-2.5 text-xs",
              current === option.value && "pointer-events-none"
            )}
            key={option.label}
            onClick={() => onChange(option.value)}
            size="sm"
            variant={current === option.value ? "default" : "ghost"}
          >
            {option.label}
          </Button>
        ))}
      </nav>
    </div>
  );
}

export function RunsFilters(): ReactNode {
  const [statusFilter, setStatusFilter] = useAtom(analyticsStatusFilterAtom);
  const [sourceFilter, setSourceFilter] = useAtom(analyticsSourceFilterAtom);

  const handleStatusChange = useCallback(
    (value: NormalizedStatus | undefined): void => {
      setStatusFilter(value);
    },
    [setStatusFilter]
  );

  const handleSourceChange = useCallback(
    (value: RunSource | undefined): void => {
      setSourceFilter(value);
    },
    [setSourceFilter]
  );

  return (
    <div className="flex flex-wrap items-center gap-4">
      <FilterGroup
        current={statusFilter}
        label="Status"
        onChange={handleStatusChange}
        options={STATUS_OPTIONS}
      />
      <div className="h-5 w-px bg-border" />
      <FilterGroup
        current={sourceFilter}
        label="Source"
        onChange={handleSourceChange}
        options={SOURCE_OPTIONS}
      />
    </div>
  );
}
