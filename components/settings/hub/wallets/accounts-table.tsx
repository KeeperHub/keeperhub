"use client";

import {
  ChevronRight,
  Plus,
  RefreshCw,
  ShieldCheck,
  Wallet,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
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
import { cn } from "@/lib/utils";
import {
  accountSlug,
  type WalletAccounts,
} from "@/lib/wallet/use-wallet-accounts";
import { SETTINGS_HEAD_ROW, SETTINGS_ROW } from "../section";
import { useSettingsContext } from "../settings-context";
import { AccountAddress } from "./account-address";

const SKELETON_ROWS = ["a", "b", "c"] as const;

export function AccountsTable({
  accounts,
  canManage,
  loading,
  onAddSafe,
  onFindExisting,
  finding,
}: {
  accounts: WalletAccounts;
  /** Draws the same rows with their contents blanked, so nothing resizes. */
  loading: boolean;
  canManage: boolean;
  onAddSafe: () => void;
  /** Looks on chain for Safes already deployed at this org's address. */
  onFindExisting: () => void;
  finding: boolean;
}): React.ReactElement {
  const router = useRouter();
  const { organizationId } = useSettingsContext();

  return (
    <Table>
      <TableHeader>
        <TableRow className={SETTINGS_HEAD_ROW}>
          <TableHead>Account</TableHead>
          <TableHead>Network</TableHead>
          <TableHead className="w-8" />
        </TableRow>
      </TableHeader>
      <TableBody>
        {loading &&
          SKELETON_ROWS.map((key) => (
            <TableRow className={SETTINGS_ROW} key={key}>
              <TableCell>
                <div className="flex items-start gap-3">
                  <Skeleton className="mt-0.5 size-8 shrink-0 rounded-lg" />
                  <span className="flex flex-col gap-1.5">
                    <Skeleton className="h-5 w-40" />
                    <Skeleton className="h-4 w-72" />
                  </span>
                </div>
              </TableCell>
              <TableCell>
                <Skeleton className="h-5 w-28" />
              </TableCell>
              <TableCell />
            </TableRow>
          ))}
        {!loading &&
          accounts.all.map((account) => {
            const isSafe = account.kind === "safe";
            const isSolana = !isSafe && account.family === "solana";
            // Named for the family, matching the toolbar wallet. The custody
            // provider is not something a person picks or acts on here.
            const signerName = isSolana ? "Solana" : "EVM";
            const name = isSafe ? `Safe on ${account.chainName}` : signerName;
            const network = isSolana ? "Solana" : "EVM networks";
            return (
              <TableRow
                className={cn("group cursor-pointer", SETTINGS_ROW)}
                key={accountSlug(account)}
                onClick={() =>
                  router.push(
                    `/settings/${organizationId}/wallets/${accountSlug(account)}`
                  )
                }
              >
                <TableCell>
                  <div className="flex items-start gap-3">
                    <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted">
                      {isSafe ? (
                        <ShieldCheck className="size-4" />
                      ) : (
                        <Wallet className="size-4" />
                      )}
                    </span>
                    <span className="flex min-w-0 flex-col gap-0.5">
                      <span className="font-medium">{name}</span>
                      <AccountAddress
                        address={account.address}
                        chainId={isSafe ? account.chainId : undefined}
                        isEvm={!isSolana}
                      />
                    </span>
                  </div>
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {isSafe ? account.chainName : network}
                </TableCell>
                <TableCell className="text-right">
                  <ChevronRight className="size-4 text-muted-foreground" />
                </TableCell>
              </TableRow>
            );
          })}
        {!loading && canManage && (
          // Adding an account belongs with the accounts, not in the card's
          // header: the header buttons named Safe operations rather than the
          // thing the user is after, which is another wallet.
          <TableRow className={cn("group", SETTINGS_ROW)}>
            <TableCell colSpan={2}>
              <button
                className="flex items-center gap-3 text-left"
                onClick={onAddSafe}
                type="button"
              >
                <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-dashed">
                  <Plus className="size-4 text-muted-foreground" />
                </span>
                <span className="flex flex-col gap-0.5">
                  <span className="font-medium">Add a Safe account</span>
                  <span className="text-muted-foreground text-xs">
                    A smart account that holds funds and signs on one network.
                  </span>
                </span>
              </button>
            </TableCell>
            <TableCell className="text-right">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    disabled={finding}
                    onClick={onFindExisting}
                    size="sm"
                    variant="ghost"
                  >
                    <RefreshCw
                      className={cn("size-3.5", finding && "animate-spin")}
                    />
                    Find existing
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="left">
                  Looks on chain for Safes already deployed at this
                  organization's address but not listed here.
                </TooltipContent>
              </Tooltip>
            </TableCell>
          </TableRow>
        )}
      </TableBody>
    </Table>
  );
}
