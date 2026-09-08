"use client";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useSession } from "@/lib/auth-client";
import type { PageMeta } from "@/lib/pagination";
import {
  HELD_PAYMENT_STATUSES,
  type HeldPaymentView,
} from "@/lib/tempo/held-payment-view";
import { HeldPaymentsTable } from "./held-payments-table";
import {
  HELD_PAYMENT_PAGE_SIZES,
  type HeldPaymentStatusFilter,
  useHeldPayments,
} from "./use-held-payments";

function MessageCard({
  title,
  message,
}: {
  title: string;
  message: string;
}): React.ReactElement {
  return (
    <Card>
      <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
        <p className="font-medium text-base">{title}</p>
        <p className="max-w-md text-muted-foreground text-sm">{message}</p>
      </CardContent>
    </Card>
  );
}

function LoadingCard(): React.ReactElement {
  return (
    <Card>
      <CardContent className="flex flex-col gap-3 py-6">
        {[0, 1, 2, 3].map((row) => (
          <Skeleton className="h-10 w-full" key={row} />
        ))}
      </CardContent>
    </Card>
  );
}

function Pager({
  meta,
  onPageChange,
}: {
  meta: PageMeta;
  onPageChange: (page: number) => void;
}): React.ReactElement | null {
  if (meta.totalPages <= 1) {
    return null;
  }
  return (
    <div className="flex items-center justify-between">
      <p className="text-muted-foreground text-sm">
        {meta.total} held payment{meta.total === 1 ? "" : "s"}
      </p>
      <div className="flex items-center gap-2">
        <Button
          disabled={meta.page <= 1}
          onClick={() => onPageChange(meta.page - 1)}
          size="sm"
          variant="outline"
        >
          Previous
        </Button>
        <span className="text-muted-foreground text-sm">
          Page {meta.page} of {meta.totalPages}
        </span>
        <Button
          disabled={meta.page >= meta.totalPages}
          onClick={() => onPageChange(meta.page + 1)}
          size="sm"
          variant="outline"
        >
          Next
        </Button>
      </div>
    </div>
  );
}

function ListBody({
  loading,
  error,
  payments,
  meta,
  filtered,
  onChange,
  onPageChange,
}: {
  loading: boolean;
  error: string | null;
  payments: HeldPaymentView[];
  meta: PageMeta | null;
  filtered: boolean;
  onChange: () => void;
  onPageChange: (page: number) => void;
}): React.ReactElement {
  if (loading) {
    return <LoadingCard />;
  }
  if (error) {
    return <MessageCard message={error} title="Could not load held payments" />;
  }
  if (payments.length === 0) {
    return filtered ? (
      <MessageCard
        message="No held payments match the current status or search. Clear the filters to see everything."
        title="No matches"
      />
    ) : (
      <MessageCard
        message="Payments you sign and hold with the Tempo Sign & Hold Payment action appear here, ready to broadcast now or at their scheduled time."
        title="No held payments"
      />
    );
  }
  return (
    <div className="flex flex-col gap-4">
      <HeldPaymentsTable onChange={onChange} payments={payments} />
      {meta && <Pager meta={meta} onPageChange={onPageChange} />}
    </div>
  );
}

function gatedMessage(
  error: string | null
): { title: string; message: string } | null {
  if (error === "AUTH_REQUIRED") {
    return {
      title: "Sign in required",
      message: "Sign in as an organization owner to view held payments.",
    };
  }
  if (error === "OWNER_REQUIRED") {
    return {
      title: "Owners only",
      message:
        "Held payments release organization funds, so only organization owners can view and manage them.",
    };
  }
  return null;
}

export function HeldPaymentsPage(): React.ReactElement {
  const { isPending } = useSession();
  const {
    payments,
    meta,
    loading,
    error,
    setPage,
    pageSize,
    setPageSize,
    search,
    setSearch,
    status,
    setStatus,
    refetch,
  } = useHeldPayments();

  const gated = gatedMessage(error);

  return (
    <div className="pointer-events-auto fixed inset-0 overflow-y-auto bg-sidebar">
      <div className="transition-[margin-left] duration-200 ease-out md:ml-[var(--nav-content-offset,var(--nav-sidebar-width,60px))]">
        <div className="flex flex-col gap-6 p-6 pt-[calc(5rem+var(--app-banner-height,0px))]">
          <div className="flex flex-col gap-1">
            <h1 className="font-semibold text-2xl">Held Payments</h1>
            <p className="text-muted-foreground text-sm">
              Tempo payments signed and held, ready to broadcast now or at their
              scheduled time.
            </p>
          </div>

          {gated ? (
            <MessageCard message={gated.message} title={gated.title} />
          ) : (
            <div className="flex flex-col gap-4">
              <div className="flex flex-wrap items-center gap-3">
                <Input
                  className="max-w-sm flex-1"
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search memo, address, token, or tx hash"
                  value={search}
                />
                <Select
                  onValueChange={(v) => setStatus(v as HeldPaymentStatusFilter)}
                  value={status}
                >
                  <SelectTrigger className="w-[150px] capitalize">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All statuses</SelectItem>
                    {HELD_PAYMENT_STATUSES.map((s) => (
                      <SelectItem className="capitalize" key={s} value={s}>
                        {s}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select
                  onValueChange={(v) => setPageSize(Number(v))}
                  value={String(pageSize)}
                >
                  <SelectTrigger className="w-[140px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {HELD_PAYMENT_PAGE_SIZES.map((size) => (
                      <SelectItem key={size} value={String(size)}>
                        {size} per page
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <ListBody
                error={error}
                filtered={status !== "all" || search.trim() !== ""}
                loading={isPending || loading}
                meta={meta}
                onChange={refetch}
                onPageChange={setPage}
                payments={payments}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
