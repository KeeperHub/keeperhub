"use client";

import { Check, Copy, ExternalLink } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { ConfirmOverlay } from "@/components/overlays/confirm-overlay";
import { useOverlay } from "@/components/overlays/overlay-provider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { heldPaymentApi } from "@/lib/api-client";
import type {
  HeldPaymentStatus,
  HeldPaymentView,
} from "@/lib/tempo/held-payment-view";
import { cn } from "@/lib/utils";
import { BroadcastHeldPaymentOverlay } from "./broadcast-overlay";

const STATUS_STYLES: Record<HeldPaymentStatus, string> = {
  pending: "bg-gray-500/10 text-gray-700 dark:text-gray-400 border-gray-500/20",
  broadcasting:
    "bg-blue-500/10 text-blue-700 dark:text-blue-400 border-blue-500/20",
  broadcast:
    "bg-blue-500/10 text-blue-700 dark:text-blue-400 border-blue-500/20",
  confirmed:
    "bg-green-500/10 text-green-700 dark:text-green-400 border-green-500/20",
  failed: "bg-red-500/10 text-red-700 dark:text-red-400 border-red-500/20",
  expired:
    "bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/20",
  canceled:
    "bg-orange-500/10 text-orange-700 dark:text-orange-400 border-orange-500/20",
};

const TEMPO_EXPLORERS: Record<number, string> = {
  4217: "https://explore.mainnet.tempo.xyz",
  42431: "https://explore.testnet.tempo.xyz",
};

function networkLabel(chainId: number): string {
  if (chainId === 4217) {
    return "Tempo";
  }
  if (chainId === 42_431) {
    return "Tempo Testnet";
  }
  return `Chain ${chainId}`;
}

function explorerUrl(chainId: number, path: string): string | null {
  const base = TEMPO_EXPLORERS[chainId];
  return base ? `${base}/${path}` : null;
}

function shorten(value: string): string {
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function CopyButton({
  value,
  label,
}: {
  value: string;
  label: string;
}): React.ReactElement {
  const [copied, setCopied] = useState(false);
  return (
    <button
      aria-label={label}
      className="inline-flex shrink-0 text-muted-foreground transition-colors hover:text-foreground"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        } catch {
          toast.error("Could not copy to clipboard");
        }
      }}
      title={label}
      type="button"
    >
      {copied ? (
        <Check className="size-3.5 text-green-600" />
      ) : (
        <Copy className="size-3.5" />
      )}
    </button>
  );
}

function ExplorerLink({
  url,
  label,
}: {
  url: string;
  label: string;
}): React.ReactElement {
  return (
    <a
      aria-label={label}
      className="inline-flex shrink-0 text-muted-foreground transition-colors hover:text-foreground"
      href={url}
      rel="noopener noreferrer"
      target="_blank"
      title={label}
    >
      <ExternalLink className="size-3.5" />
    </a>
  );
}

function StatusBadge({
  status,
}: {
  status: HeldPaymentStatus;
}): React.ReactElement {
  return (
    <Badge
      className={cn("capitalize", STATUS_STYLES[status])}
      variant="outline"
    >
      {status}
    </Badge>
  );
}

function TokenCell({
  chainId,
  symbol,
  address,
}: {
  chainId: number;
  symbol: string | null;
  address: string;
}): React.ReactElement {
  const url = explorerUrl(chainId, `address/${address}`);
  return (
    <div className="flex items-center gap-1.5 whitespace-nowrap">
      <span>{symbol ?? shorten(address)}</span>
      <CopyButton label="Copy token address" value={address} />
      {url && <ExplorerLink label="View token on explorer" url={url} />}
    </div>
  );
}

function TxCell({
  chainId,
  broadcastTxHash,
}: {
  chainId: number;
  broadcastTxHash: string | null;
}): React.ReactElement {
  // A held payment only has a signed blob until it is broadcast; there is no
  // on-chain transaction to show or link to before then.
  if (!broadcastTxHash) {
    return <span className="text-muted-foreground text-xs">Not broadcast</span>;
  }
  const url = explorerUrl(chainId, `tx/${broadcastTxHash}`);
  return (
    <div className="flex items-center gap-1.5 whitespace-nowrap">
      <span
        className="font-mono text-muted-foreground text-xs"
        title={broadcastTxHash}
      >
        {shorten(broadcastTxHash)}
      </span>
      <CopyButton label="Copy transaction hash" value={broadcastTxHash} />
      {url && <ExplorerLink label="View transaction on explorer" url={url} />}
    </div>
  );
}

function MemoCell({ memo }: { memo: string | null }): React.ReactElement {
  if (!memo) {
    return <span className="text-muted-foreground text-xs">-</span>;
  }
  return (
    <div className="flex max-w-[10rem] items-center gap-1.5">
      <span
        className="min-w-0 truncate text-muted-foreground text-xs"
        title={memo}
      >
        {memo}
      </span>
      <CopyButton label="Copy memo" value={memo} />
    </div>
  );
}

function RowActions({
  payment,
  onBroadcast,
  onCancel,
}: {
  payment: HeldPaymentView;
  onBroadcast: (payment: HeldPaymentView) => void;
  onCancel: (payment: HeldPaymentView) => void;
}): React.ReactElement {
  if (payment.status === "pending") {
    return (
      <div className="flex justify-end gap-2">
        <Button onClick={() => onBroadcast(payment)} size="sm">
          Broadcast
        </Button>
        <Button onClick={() => onCancel(payment)} size="sm" variant="outline">
          Cancel
        </Button>
      </div>
    );
  }
  if (payment.status === "failed" && payment.lastError) {
    return (
      <span className="text-muted-foreground text-xs" title={payment.lastError}>
        Failed
      </span>
    );
  }
  return <span className="text-muted-foreground text-xs">-</span>;
}

export function HeldPaymentsTable({
  payments,
  onChange,
}: {
  payments: HeldPaymentView[];
  onChange: () => void;
}): React.ReactElement {
  const { open } = useOverlay();

  const onBroadcast = (payment: HeldPaymentView): void => {
    open(BroadcastHeldPaymentOverlay, { payment, onDone: onChange });
  };

  const onCancel = (payment: HeldPaymentView): void => {
    open(ConfirmOverlay, {
      title: "Cancel held payment",
      message:
        "This releases the hold so the payment will never broadcast. This cannot be undone.",
      confirmLabel: "Cancel payment",
      destructive: true,
      onConfirm: async () => {
        try {
          await heldPaymentApi.cancel(payment.id);
          toast.success("Held payment canceled");
          onChange();
        } catch (err) {
          toast.error(
            err instanceof Error ? err.message : "Failed to cancel the payment"
          );
        }
      },
    });
  };

  return (
    <Card className="overflow-hidden py-0">
      <CardContent className="p-0">
        <div className="overflow-x-auto">
          <Table className="[&_td]:px-4 [&_th]:px-4">
            <TableHeader>
              <TableRow>
                <TableHead>Status</TableHead>
                <TableHead>Payment ID</TableHead>
                <TableHead>Amount</TableHead>
                <TableHead>Token</TableHead>
                <TableHead>Network</TableHead>
                <TableHead>Recipient</TableHead>
                <TableHead>Memo</TableHead>
                <TableHead>Tx</TableHead>
                <TableHead>Release</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {payments.map((payment) => (
                <TableRow key={payment.id}>
                  <TableCell>
                    <StatusBadge status={payment.status} />
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1.5 whitespace-nowrap">
                      <span className="font-mono text-muted-foreground text-xs">
                        {shorten(payment.id)}
                      </span>
                      <CopyButton label="Copy payment ID" value={payment.id} />
                    </div>
                  </TableCell>
                  <TableCell className="whitespace-nowrap font-medium">
                    {payment.amount ?? "-"}
                  </TableCell>
                  <TableCell>
                    <TokenCell
                      address={payment.tokenAddress}
                      chainId={payment.chainId}
                      symbol={payment.tokenSymbol}
                    />
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-muted-foreground text-xs">
                    {networkLabel(payment.chainId)}
                  </TableCell>
                  <TableCell className="whitespace-nowrap font-mono text-xs">
                    <div className="flex items-center gap-1.5">
                      {shorten(payment.to)}
                      <CopyButton
                        label="Copy recipient address"
                        value={payment.to}
                      />
                    </div>
                  </TableCell>
                  <TableCell>
                    <MemoCell memo={payment.memo} />
                  </TableCell>
                  <TableCell>
                    <TxCell
                      broadcastTxHash={payment.broadcastTxHash}
                      chainId={payment.chainId}
                    />
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-xs capitalize">
                    {payment.broadcastMode}
                    {payment.broadcastAt
                      ? ` (${new Date(payment.broadcastAt).toLocaleString()})`
                      : ""}
                  </TableCell>
                  <TableCell className="text-right">
                    <RowActions
                      onBroadcast={onBroadcast}
                      onCancel={onCancel}
                      payment={payment}
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}
