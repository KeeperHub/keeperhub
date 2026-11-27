import type { ReactNode } from "react";
import {
  rpcEndpointUsageLabel,
  rpcStepEndpointLabel,
} from "@/lib/analytics/rpc-usage-shape";
import type { RpcEndpointUsageView } from "@/lib/analytics/types";
import type { RpcOrigin } from "@/lib/rpc/engine/types";

type StepRpcEndpointProps = {
  step: {
    rpcOrigin: RpcOrigin | null;
    rpcConfigName: string | null;
    rpcFailedOver: boolean | null;
  };
};

/** Which endpoint served the step's RPC calls, and whether it failed over. */
export function StepRpcEndpoint({ step }: StepRpcEndpointProps): ReactNode {
  const label = rpcStepEndpointLabel(step);
  if (label === null) {
    return null;
  }
  // text-[0.625rem] is --ds-text-2xs, the badge size.
  return (
    <span className="inline-flex shrink-0 items-center gap-1">
      <span
        className="rounded bg-muted px-1 py-0.5 text-[0.625rem] text-muted-foreground"
        data-rpc-origin={step.rpcOrigin}
        data-testid="step-rpc-endpoint"
      >
        {label}
      </span>
      {step.rpcFailedOver ? (
        <span
          className="rounded bg-destructive/10 px-1 py-0.5 text-[0.625rem] text-destructive"
          data-testid="step-rpc-failed-over"
        >
          failed over
        </span>
      ) : null}
    </span>
  );
}

function countLabel(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function usageKey(usage: RpcEndpointUsageView): string {
  return `${usage.origin}:${usage.configId ?? ""}:${usage.position}`;
}

/** The same endpoints on one line, for a table row. */
export function StepRpcEndpointsInline({
  endpoints,
}: {
  endpoints: RpcEndpointUsageView[];
}): ReactNode {
  if (endpoints.length < 2) {
    return null;
  }
  // text-[0.625rem] is --ds-text-2xs, the badge size.
  return (
    <span
      className="flex flex-wrap items-center gap-1"
      data-testid="step-rpc-endpoints"
    >
      {endpoints.map((usage) => (
        <span
          className="rounded bg-muted px-1 py-0.5 text-[0.625rem] text-muted-foreground"
          data-rpc-origin={usage.origin}
          data-rpc-position={usage.position}
          key={usageKey(usage)}
        >
          {rpcEndpointUsageLabel(usage)}:{" "}
          {countLabel(usage.requests, "call", "calls")}
          {usage.errors > 0
            ? `, ${countLabel(usage.errors, "failed", "failed")}`
            : ""}
        </span>
      ))}
    </span>
  );
}

/** Every endpoint the step's calls reached, with how many each served. */
export function StepRpcEndpoints({
  endpoints,
}: {
  endpoints: RpcEndpointUsageView[];
}): ReactNode {
  if (endpoints.length === 0) {
    return null;
  }
  return (
    <div className="space-y-1" data-testid="step-rpc-endpoints">
      <div className="font-medium text-muted-foreground text-xs">
        RPC endpoints
      </div>
      <ul className="divide-y divide-border rounded-lg border">
        {endpoints.map((usage) => (
          <li
            className="flex items-center justify-between gap-3 px-3 py-1.5 text-xs"
            data-rpc-origin={usage.origin}
            data-rpc-position={usage.position}
            key={usageKey(usage)}
          >
            <span className="min-w-0 truncate">
              {rpcEndpointUsageLabel(usage)}
            </span>
            <span className="shrink-0 text-muted-foreground tabular-nums">
              {countLabel(usage.requests, "call", "calls")}
              {usage.errors > 0 ? (
                <span className="ml-2 text-destructive">
                  {countLabel(usage.errors, "failed", "failed")}
                </span>
              ) : null}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
