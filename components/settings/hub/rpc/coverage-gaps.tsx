"use client";

import { ExternalLink } from "lucide-react";
import Link from "next/link";
import type { CoverageGap } from "@/lib/rpc/engine/org/coverage";
import { groupGapsByWorkflow, workflowEditorHref } from "./model";

/** The workflow nodes a change would leave without an RPC endpoint. */
export function CoverageGapList({
  gaps,
  chainName,
}: {
  gaps: readonly CoverageGap[];
  chainName: (chainId: number) => string;
}): React.ReactElement {
  return (
    <ul className="flex flex-col gap-3">
      {groupGapsByWorkflow(gaps).map((workflow) => (
        <li className="flex flex-col gap-1" key={workflow.workflowId}>
          <Link
            className="inline-flex w-fit items-center gap-1 font-medium text-foreground text-sm underline-offset-4 hover:underline"
            href={workflowEditorHref(workflow.workflowId)}
          >
            {workflow.workflowName}
            <ExternalLink aria-hidden="true" className="size-3" />
          </Link>
          <ul className="flex flex-col gap-1 border-l pl-3">
            {workflow.gaps.map((gap) => (
              <li
                className="text-muted-foreground text-xs"
                key={`${gap.nodeId}:${gap.chainId}:${gap.code}`}
              >
                <span className="font-medium text-foreground">
                  {gap.nodeLabel}
                </span>{" "}
                on {chainName(gap.chainId)}: {gap.message}
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ul>
  );
}
