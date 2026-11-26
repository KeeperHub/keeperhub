"use client";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { buildRpcConfigOptions } from "@/lib/workflow/editor/rpc-config-options";
import type { ActionConfigFieldBase } from "@/plugins/registry";
import { useOrgRpcState } from "./use-org-rpc-state";

const DEFAULT_NETWORK_KEY = "network";

type RpcConfigSelectFieldProps = {
  field: ActionConfigFieldBase;
  config: Record<string, unknown>;
  onUpdateConfig: (key: string, value: unknown) => void;
  disabled?: boolean;
};

export function RpcConfigSelectField({
  field,
  config,
  onUpdateConfig,
  disabled,
}: RpcConfigSelectFieldProps): React.ReactNode {
  const { state, loading } = useOrgRpcState();

  if (loading) {
    return (
      <div className="flex h-10 items-center justify-center rounded-md border">
        <Spinner className="h-4 w-4" />
        <span className="ml-2 text-muted-foreground text-sm">
          Loading RPC configs...
        </span>
      </div>
    );
  }

  const built = buildRpcConfigOptions(
    config[field.key],
    config[field.networkField ?? DEFAULT_NETWORK_KEY],
    state
  );

  return (
    <div className="space-y-1">
      <Select
        disabled={disabled}
        onValueChange={(value: string) => onUpdateConfig(field.key, value)}
        value={built.value}
      >
        <SelectTrigger
          aria-invalid={built.problem ? true : undefined}
          className="w-full"
          id={field.key}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {built.options.map((option) => (
            <SelectItem
              description={option.hint}
              disabled={option.disabled}
              key={option.value}
              value={option.value}
            >
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {built.problem && (
        <p
          className="text-destructive text-xs"
          data-testid={`rpc-config-problem-${field.key}`}
        >
          {built.problem}
        </p>
      )}
    </div>
  );
}
