"use client";

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
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
import { BILLING_API } from "@/lib/billing/constants";
import type { InvoiceItem } from "@/lib/billing/provider";
import { useCachedResource } from "@/lib/hooks/use-cached-resource";
import { useOrganization } from "@/lib/hooks/use-organization";

type InvoiceResponse = {
  invoices: Array<{
    id: string;
    date: string;
    amount: number;
    currency: string;
    status: InvoiceItem["status"];
    description: string;
    periodStart: string;
    periodEnd: string;
    invoiceUrl: string | null;
    pdfUrl: string | null;
    executionsUsed: number;
    executionLimit: number;
  }>;
  hasMore: boolean;
};

const STATUS_VARIANT: Record<
  InvoiceItem["status"],
  "default" | "secondary" | "destructive" | "outline"
> = {
  paid: "default",
  open: "secondary",
  uncollectible: "destructive",
  void: "outline",
  draft: "outline",
};

function formatAmount(amount: number, currency: string): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
  }).format(amount / 100);
}

function formatDate(dateString: string): string {
  return new Date(dateString).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatPeriod(start: string, end: string): string {
  const startDate = new Date(start).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
  const endDate = new Date(end).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  return `${startDate} - ${endDate}`;
}

const compactNumber = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});

function formatUsageCompact(used: number, limit: number): string {
  const usedLabel = compactNumber.format(used);
  const limitLabel = limit === -1 ? "∞" : compactNumber.format(limit);
  return `${usedLabel} / ${limitLabel}`;
}

function formatUsageExact(used: number, limit: number): string {
  const limitLabel = limit === -1 ? "Unlimited" : limit.toLocaleString();
  return `${used.toLocaleString()} / ${limitLabel} executions`;
}

const PAGE_SIZE = 10;

export function BillingHistory(): React.ReactElement {
  const { organization } = useOrganization();
  const [extra, setExtra] = useState<InvoiceResponse["invoices"]>([]);
  const [moreHasMore, setMoreHasMore] = useState<boolean | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  // The first page is remembered, so coming back to billing shows the invoices
  // it showed last time while the fresh ones are on their way.
  const firstPage = useCachedResource<InvoiceResponse>(
    organization?.id ? `invoices:${organization.id}` : null,
    async () => {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
      const response = await fetch(`${BILLING_API.INVOICES}?${params}`);
      if (!response.ok) {
        throw new Error(`Failed to fetch invoices: ${response.status}`);
      }
      return (await response.json()) as InvoiceResponse;
    }
  );

  const invoices = [...(firstPage.data?.invoices ?? []), ...extra];

  const loading = firstPage.loading;
  const hasMore = moreHasMore ?? firstPage.data?.hasMore ?? false;

  async function handleLoadMore(): Promise<void> {
    const lastInvoice = invoices.at(-1);
    if (!lastInvoice) {
      return;
    }

    setLoadingMore(true);
    try {
      const params = new URLSearchParams({
        limit: String(PAGE_SIZE),
        startingAfter: lastInvoice.id,
      });
      const response = await fetch(`${BILLING_API.INVOICES}?${params}`);
      if (!response.ok) {
        console.error("[Billing] Failed to fetch invoices:", response.status);
        return;
      }
      const data = (await response.json()) as InvoiceResponse;
      setExtra((prev) => [...prev, ...data.invoices]);
      setMoreHasMore(data.hasMore);
    } finally {
      setLoadingMore(false);
    }
  }

  if (loading) {
    return (
      <Card className="bg-sidebar">
        <CardHeader>
          <Skeleton className="h-6 w-32" />
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            <div className="flex gap-4">
              <Skeleton className="h-4 w-20" />
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-4 w-16" />
              <Skeleton className="h-4 w-28" />
              <Skeleton className="h-4 w-20" />
              <Skeleton className="h-4 w-12" />
              <Skeleton className="h-4 w-16" />
            </div>
            {Array.from({ length: 3 }, (_, i) => (
              <div className="flex gap-4" key={`skeleton-row-${String(i)}`}>
                <Skeleton className="h-4 w-20" />
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-4 w-16" />
                <Skeleton className="h-4 w-28" />
                <Skeleton className="h-4 w-20" />
                <Skeleton className="h-4 w-12 rounded-full" />
                <Skeleton className="h-4 w-16" />
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    );
  }

  if (invoices.length === 0) {
    return (
      <Card className="bg-sidebar">
        <CardHeader>
          <CardTitle>Billing History</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground text-sm">
            No billing history available.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="bg-sidebar">
      <CardHeader>
        <CardTitle>Billing History</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Date</TableHead>
              <TableHead>Description</TableHead>
              <TableHead>Amount</TableHead>
              <TableHead>Period</TableHead>
              <TableHead>Usage</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Invoice</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {invoices.map((invoice) => (
              <TableRow key={invoice.id}>
                <TableCell className="whitespace-nowrap">
                  {formatDate(invoice.date)}
                </TableCell>
                <TableCell>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="block max-w-[240px] truncate text-left">
                        {invoice.description}
                      </span>
                    </TooltipTrigger>
                    <TooltipContent>{invoice.description}</TooltipContent>
                  </Tooltip>
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  {formatAmount(invoice.amount, invoice.currency)}
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  {formatPeriod(invoice.periodStart, invoice.periodEnd)}
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="cursor-help tabular-nums">
                        {formatUsageCompact(
                          invoice.executionsUsed,
                          invoice.executionLimit
                        )}
                      </span>
                    </TooltipTrigger>
                    <TooltipContent>
                      {formatUsageExact(
                        invoice.executionsUsed,
                        invoice.executionLimit
                      )}
                    </TooltipContent>
                  </Tooltip>
                </TableCell>
                <TableCell>
                  <Badge variant={STATUS_VARIANT[invoice.status]}>
                    {invoice.status}
                  </Badge>
                </TableCell>
                <TableCell className="space-x-2">
                  {invoice.invoiceUrl && (
                    <a
                      className="text-sm text-keeperhub-green-dark underline underline-offset-2 hover:text-keeperhub-green"
                      href={invoice.invoiceUrl}
                      rel="noopener"
                      target="_blank"
                    >
                      View
                    </a>
                  )}
                  {invoice.pdfUrl && (
                    <a
                      className="text-sm text-keeperhub-green-dark underline underline-offset-2 hover:text-keeperhub-green"
                      href={invoice.pdfUrl}
                      rel="noopener"
                      target="_blank"
                    >
                      PDF
                    </a>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>

        {hasMore && (
          <div className="flex justify-center">
            <Button
              disabled={loadingMore}
              onClick={handleLoadMore}
              variant="outline"
            >
              {loadingMore ? "Loading..." : "Load more"}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
