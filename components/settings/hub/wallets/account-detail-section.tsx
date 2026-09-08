"use client";

import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { useOrgWallet } from "@/lib/wallet/use-org-wallet";
import {
  accountSlug,
  accountTitle,
  accountTitleForSlug,
  useWalletAccounts,
} from "@/lib/wallet/use-wallet-accounts";
import { SectionHeader, SettingsCard, VEILED } from "../section";
import { useSettingsContext } from "../settings-context";
import { FormSkeleton, StatTilesSkeleton, TableSkeleton } from "../skeletons";
import { AccountAddress } from "./account-address";
import { AccountDetailPanel } from "./account-detail-panel";
import { AssetFilters } from "./asset-filters";

const noop = (): void => undefined;

export function AccountDetailSection({
  accountId,
}: {
  accountId: string;
}): React.ReactElement {
  const { organizationId } = useSettingsContext();
  const state = useOrgWallet();
  const { all } = useWalletAccounts({
    chains: state.chains,
    safes: state.safes,
    solanaAddress: state.walletData?.solanaAddress,
    solanaIsTestnet: state.solanaIsTestnet,
    walletAddress: state.walletData?.walletAddress,
  });
  const account = all.find((a) => accountSlug(a) === accountId);

  const back = (
    <Button aria-label="All wallets" asChild size="icon" variant="outline">
      <Link href={`/settings/${organizationId}/wallets`}>
        <ArrowLeft className="size-4" />
      </Link>
    </Button>
  );

  // A Safe is only missing once the Safes have actually been fetched; they
  // arrive after the wallet, and until then the list is simply empty.
  const isSignerSlug = accountId === "evm" || accountId === "solana";
  const pending =
    state.walletLoading ||
    (!isSignerSlug &&
      state.walletData?.hasWallet === true &&
      !state.safesLoaded);

  if (pending) {
    return (
      <>
        {/* The same shape the loaded page has: an address under the name,
            three tiles, then the cards. Anything missing here moves
            everything below it once the account arrives. */}
        <SectionHeader
          description={
            <span className={VEILED}>
              0x0000000000000000000000000000000000000000
            </span>
          }
          leading={back}
          title={accountTitleForSlug(accountId)}
        />
        <StatTilesSkeleton tiles={3} />
        <SettingsCard
          action={
            // The real controls, inert: a drawing of them is what moved the
            // table down when they arrived.
            <AssetFilters
              hiddenCount={0}
              network={[]}
              networks={[]}
              onNetworkChange={noop}
              onQueryChange={noop}
              onToggleZero={noop}
              query=""
              showZero={false}
            />
          }
          bodyClassName="p-2"
          title="Assets"
        >
          <TableSkeleton columns={5} leading rows={2} />
        </SettingsCard>
        <SettingsCard title="Account settings">
          <FormSkeleton rows={3} />
        </SettingsCard>
      </>
    );
  }

  if (!account) {
    return (
      <SectionHeader
        description="This account is not part of the current organization."
        leading={back}
        title="Account not found"
      />
    );
  }

  return (
    <>
      <SectionHeader
        description={
          <AccountAddress
            address={account.address}
            always
            chainId={account.kind === "safe" ? account.chainId : undefined}
            isEvm={!(account.kind === "turnkey" && account.family === "solana")}
          />
        }
        leading={back}
        title={accountTitle(account)}
      />
      <AccountDetailPanel account={account} state={state} />
    </>
  );
}
