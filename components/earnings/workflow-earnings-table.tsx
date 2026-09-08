"use client";

import { useAtomValue } from "jotai";
import { ChevronLeft, ChevronRight, ExternalLink } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { earningsDataAtom, earningsLoadingAtom } from "@/lib/atoms/earnings";
import { EARNINGS_PAGE_SIZE } from "@/lib/earnings/constants";
import type {
  SettlementStatus,
  WorkflowEarningsRow,
} from "@/lib/earnings/types";
import { cn } from "@/lib/utils";

const SETTLEMENT_STYLES: Record<SettlementStatus, string> = {
  settled:
    "bg-green-500/10 text-green-700 dark:text-green-400 border-green-500/20",
  pending:
    "bg-yellow-500/10 text-yellow-700 dark:text-yellow-400 border-yellow-500/20",
  no_payments: "bg-muted text-muted-foreground border-border",
} as const;

const SETTLEMENT_LABELS: Record<SettlementStatus, string> = {
  settled: "Settled",
  pending: "Pending",
  no_payments: "No payments",
} as const;

function truncateAddress(address: string): string {
  if (address.length <= 12) {
    return address;
  }
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function SettlementBadge({ status }: { status: SettlementStatus }): ReactNode {
  return (
    <Badge className={cn(SETTLEMENT_STYLES[status])} variant="outline">
      {SETTLEMENT_LABELS[status]}
    </Badge>
  );
}

function TopCallers({ callers }: { callers: string[] }): ReactNode {
  if (callers.length === 0) {
    return <span className="text-sm text-muted-foreground">--</span>;
  }

  return (
    <div className="flex flex-col gap-0.5">
      {callers.map((address) => (
        <Tooltip key={address}>
          <TooltipTrigger asChild>
            <span className="cursor-default font-mono text-xs text-muted-foreground">
              {truncateAddress(address)}
            </span>
          </TooltipTrigger>
          <TooltipContent>{address}</TooltipContent>
        </Tooltip>
      ))}
    </div>
  );
}

function TableSkeleton(): ReactNode {
  return (
    <TableBody>
      {Array.from({ length: 5 }).map((_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: skeleton rows have no stable id
        <TableRow key={i}>
          {Array.from({ length: 7 }).map((__, j) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: skeleton cells have no stable id
            <TableCell key={j}>
              <div className="h-4 w-full animate-pulse rounded bg-muted" />
            </TableCell>
          ))}
        </TableRow>
      ))}
    </TableBody>
  );
}

function WorkflowRow({ row }: { row: WorkflowEarningsRow }): ReactNode {
  return (
    <TableRow>
      <TableCell className="group">
        <div className="flex flex-col gap-0.5">
          <span className="flex items-center gap-1.5 text-sm font-semibold">
            {row.workflowName}
            <Link
              className="shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:text-foreground"
              href={`/workflows/${row.workflowId}`}
            >
              <ExternalLink className="size-3.5" />
            </Link>
          </span>
          {row.listedSlug ? (
            <span className="font-mono text-xs text-muted-foreground">
              {row.listedSlug}
            </span>
          ) : null}
        </div>
      </TableCell>
      <TableCell>
        <span className="text-sm">{row.grossRevenue}</span>
      </TableCell>
      <TableCell>
        <span className="text-sm font-semibold text-keeperhub-green">
          {row.creatorShare}
        </span>
      </TableCell>
      <TableCell>
        <span className="text-sm">{row.platformFee}</span>
      </TableCell>
      <TableCell>
        <span className="text-sm">{row.invocationCount.toLocaleString()}</span>
      </TableCell>
      <TableCell>
        <TopCallers callers={row.topCallers} />
      </TableCell>
      <TableCell>
        <SettlementBadge status={row.settlementStatus} />
      </TableCell>
    </TableRow>
  );
}

type WorkflowEarningsTableProps = {
  page: number;
  onPageChange: (page: number) => void;
};

export function WorkflowEarningsTable({
  page,
  onPageChange,
}: WorkflowEarningsTableProps): ReactNode {
  const data = useAtomValue(earningsDataAtom);
  const loading = useAtomValue(earningsLoadingAtom);

  const total = data?.total ?? 0;
  const pageSize = data?.pageSize ?? EARNINGS_PAGE_SIZE;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  const rangeStart = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const rangeEnd = Math.min(page * pageSize, total);

  const hasPrevious = page > 1;
  const hasNext = page < totalPages;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-xl font-semibold tracking-tight">
          Workflow Earnings
        </CardTitle>
        <div className="flex items-center gap-2">
          <span className="font-medium text-muted-foreground text-xs tabular-nums">
            {rangeStart.toLocaleString()}&ndash;{rangeEnd.toLocaleString()} of{" "}
            {total.toLocaleString()}
          </span>
          <Button
            className="size-7 p-0"
            disabled={!hasPrevious || loading}
            onClick={() => onPageChange(page - 1)}
            size="sm"
            variant="ghost"
          >
            <ChevronLeft className="size-3.5" />
          </Button>
          <Button
            className="size-7 p-0"
            disabled={!hasNext || loading}
            onClick={() => onPageChange(page + 1)}
            size="sm"
            variant="ghost"
          >
            <ChevronRight className="size-3.5" />
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="text-xs text-muted-foreground">
                Workflow
              </TableHead>
              <TableHead className="text-xs text-muted-foreground">
                Gross Revenue
              </TableHead>
              <TableHead className="text-xs text-muted-foreground">
                Earnings
              </TableHead>
              <TableHead className="text-xs text-muted-foreground">
                Platform Fee
              </TableHead>
              <TableHead className="text-xs text-muted-foreground">
                Invocations
              </TableHead>
              <TableHead className="text-xs text-muted-foreground">
                Top Callers
              </TableHead>
              <TableHead className="text-xs text-muted-foreground">
                Status
              </TableHead>
            </TableRow>
          </TableHeader>

          {loading && !data ? (
            <TableSkeleton />
          ) : (
            <TableBody>
              {!data || data.workflows.length === 0 ? (
                <TableRow>
                  <TableCell className="py-12 text-center" colSpan={7}>
                    <p className="text-sm text-muted-foreground">
                      No earnings yet
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Your workflows are listed. Earnings will appear here once
                      agents start calling them.
                    </p>
                  </TableCell>
                </TableRow>
              ) : (
                data.workflows.map((row) => (
                  <WorkflowRow key={row.workflowId} row={row} />
                ))
              )}
            </TableBody>
          )}
        </Table>
      </CardContent>
    </Card>
  );
}
