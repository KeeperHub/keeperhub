import "server-only";

import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { organization } from "@/lib/db/schema";
import { type PaygConfig, paygConfig } from "@/lib/db/schema-extensions";
import {
  PAYG_DEFAULT_CHAIN_ID,
  PAYG_DEFAULT_DAILY_CAP_USDC,
  PAYG_DEFAULT_PERIOD_CAP_USDC,
} from "./constants";
import { usdcDecimalToRaw } from "./usdc";

/**
 * The spend caps and billing-period anchor in force for an org. Caps always
 * carry a value: "0" blocks all spend rather than meaning "unset".
 */
export type PaygSettings = {
  dailyCapRaw: string;
  periodCapRaw: string;
  chainId: number;
  startedAt: Date;
  /** False while the org is still on the defaults below. */
  customized: boolean;
};

/** The org's PAYG config row (spend caps + period anchor), or null. */
export async function getPaygConfig(
  organizationId: string
): Promise<PaygConfig | null> {
  const rows = await db
    .select()
    .from(paygConfig)
    .where(eq(paygConfig.organizationId, organizationId))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * The caps to enforce for an org. Pay-as-you-go covers every free-tier org, so
 * a missing config row is not "off": it means the org never set its own caps
 * and runs on the defaults, anchored to when the organization was created.
 */
export async function getPaygSettings(
  organizationId: string
): Promise<PaygSettings> {
  const config = await getPaygConfig(organizationId);
  if (config) {
    return {
      dailyCapRaw: config.dailyCapRaw,
      periodCapRaw: config.periodCapRaw,
      chainId: config.chainId,
      startedAt: config.startedAt,
      customized: true,
    };
  }

  const rows = await db
    .select({ createdAt: organization.createdAt })
    .from(organization)
    .where(eq(organization.id, organizationId))
    .limit(1);

  return {
    dailyCapRaw: usdcDecimalToRaw(PAYG_DEFAULT_DAILY_CAP_USDC).toString(),
    periodCapRaw: usdcDecimalToRaw(PAYG_DEFAULT_PERIOD_CAP_USDC).toString(),
    chainId: PAYG_DEFAULT_CHAIN_ID,
    startedAt: rows[0]?.createdAt ?? new Date(),
    customized: false,
  };
}

/**
 * Create or update the org's PAYG config. `started_at` (the billing-period
 * anchor) is set once on insert and preserved on updates, so editing caps does
 * not reset the period.
 */
export async function upsertPaygConfig(params: {
  organizationId: string;
  /** "0" blocks all spend; there is no "unset" cap. */
  dailyCapRaw: string;
  periodCapRaw: string;
  chainId: number;
}): Promise<void> {
  await db
    .insert(paygConfig)
    .values({
      organizationId: params.organizationId,
      dailyCapRaw: params.dailyCapRaw,
      periodCapRaw: params.periodCapRaw,
      chainId: params.chainId,
    })
    .onConflictDoUpdate({
      target: paygConfig.organizationId,
      set: {
        dailyCapRaw: params.dailyCapRaw,
        periodCapRaw: params.periodCapRaw,
        chainId: params.chainId,
        updatedAt: new Date(),
      },
    });
}
