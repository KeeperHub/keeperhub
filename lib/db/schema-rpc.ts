import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { organization } from "@/lib/db/schema";
import type {
  RpcConfigMaskedUrls,
  RpcConfigVerification,
} from "@/lib/rpc/engine/org/url-slots";
import type { RpcOrigin, RpcTransport } from "@/lib/rpc/engine/types";
import { generateId } from "@/lib/utils/id";

/**
 * An organization's own RPC endpoints for one chain. The URLs carry API keys,
 * so they live in one encrypted column; members only ever see `maskedUrls`.
 * At most one config per chain is the default that workflows use on auto.
 */
export const organizationRpcConfigs = pgTable(
  "organization_rpc_configs",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => generateId()),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    chainId: integer("chain_id").notNull(),
    name: text("name").notNull(),
    isDefault: boolean("is_default").notNull().default(false),
    enabled: boolean("enabled").notNull().default(true),
    encryptedUrls: text("encrypted_urls").notNull(),
    maskedUrls: jsonb("masked_urls").$type<RpcConfigMaskedUrls>().notNull(),
    verification: jsonb("verification")
      .$type<RpcConfigVerification>()
      .notNull()
      .default({}),
    createdBy: text("created_by"),
    updatedBy: text("updated_by"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("uq_org_rpc_configs_default")
      .on(table.organizationId, table.chainId)
      .where(sql`${table.isDefault}`),
    uniqueIndex("uq_org_rpc_configs_name").on(
      table.organizationId,
      table.chainId,
      table.name
    ),
    index("idx_org_rpc_configs_org_chain").on(
      table.organizationId,
      table.chainId
    ),
  ]
);

export type OrganizationRpcConfigRow =
  typeof organizationRpcConfigs.$inferSelect;
export type NewOrganizationRpcConfigRow =
  typeof organizationRpcConfigs.$inferInsert;

/** Organization-wide RPC policy. No row means the defaults. */
export const organizationRpcPolicy = pgTable("organization_rpc_policy", {
  organizationId: text("organization_id")
    .primaryKey()
    .references(() => organization.id, { onDelete: "cascade" }),
  ownRpcOnly: boolean("own_rpc_only").notNull().default(false),
  changedBy: text("changed_by"),
  changedAt: timestamp("changed_at").notNull().defaultNow(),
});

export type OrganizationRpcPolicyRow =
  typeof organizationRpcPolicy.$inferSelect;

/**
 * Hourly RPC usage per organization and endpoint. `configId` is null for
 * KeeperHub endpoints serving the organization's traffic. Rows are only ever
 * added to, so a flushed bucket can be written more than once safely.
 */
export const organizationRpcUsageHourly = pgTable(
  "organization_rpc_usage_hourly",
  {
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    configId: text("config_id"),
    origin: text("origin").$type<RpcOrigin>().notNull(),
    chainId: integer("chain_id").notNull(),
    transport: text("transport").$type<RpcTransport>().notNull(),
    hour: timestamp("hour").notNull(),
    requests: integer("requests").notNull().default(0),
    errors: integer("errors").notNull().default(0),
    timeouts: integer("timeouts").notNull().default(0),
    rateLimited: integer("rate_limited").notNull().default(0),
    failovers: integer("failovers").notNull().default(0),
    latencyMsSum: bigint("latency_ms_sum", { mode: "number" })
      .notNull()
      .default(0),
    latencyMsMax: integer("latency_ms_max").notNull().default(0),
    wsConnects: integer("ws_connects").notNull().default(0),
    wsReconnects: integer("ws_reconnects").notNull().default(0),
    eventsReceived: integer("events_received").notNull().default(0),
  },
  (table) => [
    unique("uq_org_rpc_usage_bucket")
      .on(
        table.organizationId,
        table.configId,
        table.origin,
        table.chainId,
        table.transport,
        table.hour
      )
      .nullsNotDistinct(),
    index("idx_org_rpc_usage_org_hour").on(table.organizationId, table.hour),
  ]
);

export type OrganizationRpcUsageRow =
  typeof organizationRpcUsageHourly.$inferSelect;
