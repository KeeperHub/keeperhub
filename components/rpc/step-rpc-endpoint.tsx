import type { ReactNode } from "react";
import { rpcStepEndpointLabel } from "@/lib/analytics/rpc-usage-shape";
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
