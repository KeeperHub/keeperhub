"use client";

import { use } from "react";
import { AccountDetailSection } from "@/components/settings/hub/wallets/account-detail-section";

export default function Page({
  params,
}: {
  params: Promise<{ accountId: string }>;
}): React.ReactElement {
  const { accountId } = use(params);
  return <AccountDetailSection accountId={accountId} />;
}
