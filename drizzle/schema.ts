import { pgTable, foreignKey, unique, text, timestamp, jsonb, boolean, index, uniqueIndex, integer, serial, primaryKey, numeric } from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"

export const sessions = pgTable("sessions", {
	id: text().primaryKey().notNull(),
	expiresAt: timestamp("expires_at", { mode: 'string' }).notNull(),
	token: text().notNull(),
	createdAt: timestamp("created_at", { mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { mode: 'string' }).notNull(),
	ipAddress: text("ip_address"),
	userAgent: text("user_agent"),
	userId: text("user_id").notNull(),
	activeOrganizationId: text("active_organization_id"),
}, (table) => [
	foreignKey({
			columns: [table.userId],
			foreignColumns: [users.id],
			name: "sessions_user_id_users_id_fk"
		}),
	unique("sessions_token_unique").on(table.token),
]);

export const workflowExecutionLogs = pgTable("workflow_execution_logs", {
	id: text().primaryKey().notNull(),
	executionId: text("execution_id").notNull(),
	nodeId: text("node_id").notNull(),
	nodeName: text("node_name").notNull(),
	nodeType: text("node_type").notNull(),
	status: text().notNull(),
	input: jsonb(),
	output: jsonb(),
	error: text(),
	startedAt: timestamp("started_at", { mode: 'string' }).defaultNow().notNull(),
	completedAt: timestamp("completed_at", { mode: 'string' }),
	duration: numeric(),
	timestamp: timestamp({ mode: 'string' }).defaultNow().notNull(),
	iterationIndex: integer("iteration_index"),
	forEachNodeId: text("for_each_node_id"),
}, (table) => [
	foreignKey({
			columns: [table.executionId],
			foreignColumns: [workflowExecutions.id],
			name: "workflow_execution_logs_execution_id_workflow_executions_id_fk"
		}),
]);

export const integrations = pgTable("integrations", {
	id: text().primaryKey().notNull(),
	createdBy: text("created_by").notNull(),
	organizationId: text("organization_id"),
	name: text().notNull(),
	type: text().notNull(),
	config: jsonb().notNull(),
	isManaged: boolean("is_managed").default(false),
	createdAt: timestamp("created_at", { mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.createdBy],
			foreignColumns: [users.id],
			name: "integrations_created_by_users_id_fk"
		}),
	foreignKey({
			columns: [table.organizationId],
			foreignColumns: [organization.id],
			name: "integrations_organization_id_organization_id_fk"
		}).onDelete("cascade"),
]);

export const verifications = pgTable("verifications", {
	id: text().primaryKey().notNull(),
	identifier: text().notNull(),
	value: text().notNull(),
	expiresAt: timestamp("expires_at", { mode: 'string' }).notNull(),
	createdAt: timestamp("created_at", { mode: 'string' }),
	updatedAt: timestamp("updated_at", { mode: 'string' }),
});

export const organizationApiKeys = pgTable("organization_api_keys", {
	id: text().primaryKey().notNull(),
	organizationId: text("organization_id").notNull(),
	name: text().notNull(),
	keyHash: text("key_hash").notNull(),
	keyPrefix: text("key_prefix").notNull(),
	createdBy: text("created_by"),
	createdAt: timestamp("created_at", { mode: 'string' }).defaultNow().notNull(),
	lastUsedAt: timestamp("last_used_at", { mode: 'string' }),
	expiresAt: timestamp("expires_at", { mode: 'string' }),
	revokedAt: timestamp("revoked_at", { mode: 'string' }),
}, (table) => [
	foreignKey({
			columns: [table.organizationId],
			foreignColumns: [organization.id],
			name: "organization_api_keys_organization_id_organization_id_fk"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.createdBy],
			foreignColumns: [users.id],
			name: "organization_api_keys_created_by_users_id_fk"
		}).onDelete("set null"),
	unique("organization_api_keys_key_hash_unique").on(table.keyHash),
]);

export const accounts = pgTable("accounts", {
	id: text().primaryKey().notNull(),
	accountId: text("account_id").notNull(),
	providerId: text("provider_id").notNull(),
	userId: text("user_id").notNull(),
	accessToken: text("access_token"),
	refreshToken: text("refresh_token"),
	idToken: text("id_token"),
	accessTokenExpiresAt: timestamp("access_token_expires_at", { mode: 'string' }),
	refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { mode: 'string' }),
	scope: text(),
	password: text(),
	createdAt: timestamp("created_at", { mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { mode: 'string' }).notNull(),
}, (table) => [
	foreignKey({
			columns: [table.userId],
			foreignColumns: [users.id],
			name: "accounts_user_id_users_id_fk"
		}),
]);

export const workflowExecutions = pgTable("workflow_executions", {
	id: text().primaryKey().notNull(),
	workflowId: text("workflow_id").notNull(),
	userId: text("user_id").notNull(),
	status: text().notNull(),
	input: jsonb(),
	output: jsonb(),
	error: text(),
	startedAt: timestamp("started_at", { mode: 'string' }).defaultNow().notNull(),
	completedAt: timestamp("completed_at", { mode: 'string' }),
	duration: numeric(),
	totalSteps: text("total_steps"),
	completedSteps: text("completed_steps").default('0'),
	currentNodeId: text("current_node_id"),
	currentNodeName: text("current_node_name"),
	lastSuccessfulNodeId: text("last_successful_node_id"),
	lastSuccessfulNodeName: text("last_successful_node_name"),
	executionTrace: jsonb("execution_trace"),
	runId: text("run_id"),
}, (table) => [
	index("idx_workflow_executions_status").using("btree", table.status.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.workflowId],
			foreignColumns: [workflows.id],
			name: "workflow_executions_workflow_id_workflows_id_fk"
		}),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [users.id],
			name: "workflow_executions_user_id_users_id_fk"
		}),
]);

export const users = pgTable("users", {
	id: text().primaryKey().notNull(),
	name: text(),
	email: text(),
	emailVerified: boolean("email_verified").default(false).notNull(),
	image: text(),
	createdAt: timestamp("created_at", { mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { mode: 'string' }).notNull(),
	isAnonymous: boolean("is_anonymous").default(false),
	deactivatedAt: timestamp("deactivated_at", { mode: 'string' }),
}, (table) => [
	unique("users_email_unique").on(table.email),
]);

export const workflowSchedules = pgTable("workflow_schedules", {
	id: text().primaryKey().notNull(),
	workflowId: text("workflow_id").notNull(),
	cronExpression: text("cron_expression").notNull(),
	timezone: text().default('UTC').notNull(),
	enabled: boolean().default(true).notNull(),
	lastRunAt: timestamp("last_run_at", { withTimezone: true, mode: 'string' }),
	lastStatus: text("last_status"),
	lastError: text("last_error"),
	nextRunAt: timestamp("next_run_at", { withTimezone: true, mode: 'string' }),
	runCount: text("run_count").default('0'),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_workflow_schedules_enabled").using("btree", table.enabled.asc().nullsLast().op("bool_ops")),
	uniqueIndex("idx_workflow_schedules_workflow").using("btree", table.workflowId.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.workflowId],
			foreignColumns: [workflows.id],
			name: "workflow_schedules_workflow_id_workflows_id_fk"
		}).onDelete("cascade"),
	unique("workflow_schedules_workflow_id_unique").on(table.workflowId),
]);

export const organizationWallets = pgTable("organization_wallets", {
	id: text().primaryKey().notNull(),
	userId: text("user_id").notNull(),
	organizationId: text("organization_id"),
	email: text().notNull(),
	walletAddress: text("wallet_address").notNull(),
	turnkeySubOrgId: text("turnkey_sub_org_id"),
	turnkeyWalletId: text("turnkey_wallet_id"),
	turnkeyPrivateKeyId: text("turnkey_private_key_id"),
	createdAt: timestamp("created_at", { mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.userId],
			foreignColumns: [users.id],
			name: "organization_wallets_user_id_users_id_fk"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.organizationId],
			foreignColumns: [organization.id],
			name: "organization_wallets_organization_id_organization_id_fk"
		}).onDelete("cascade"),
]);

export const supportedTokens = pgTable("supported_tokens", {
	id: text().primaryKey().notNull(),
	chainId: integer("chain_id").notNull(),
	tokenAddress: text("token_address").notNull(),
	symbol: text().notNull(),
	name: text().notNull(),
	decimals: integer().notNull(),
	logoUrl: text("logo_url"),
	isStablecoin: boolean("is_stablecoin").default(true).notNull(),
	sortOrder: integer("sort_order").default(0).notNull(),
	createdAt: timestamp("created_at", { mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_supported_tokens_chain").using("btree", table.chainId.asc().nullsLast().op("int4_ops")),
	unique("supported_tokens_chain_address").on(table.chainId, table.tokenAddress),
]);

export const organizationTokens = pgTable("organization_tokens", {
	id: text().primaryKey().notNull(),
	organizationId: text("organization_id").notNull(),
	chainId: integer("chain_id").notNull(),
	tokenAddress: text("token_address").notNull(),
	symbol: text().notNull(),
	name: text().notNull(),
	decimals: integer().notNull(),
	logoUrl: text("logo_url"),
	createdAt: timestamp("created_at", { mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_org_tokens_org_chain").using("btree", table.organizationId.asc().nullsLast().op("int4_ops"), table.chainId.asc().nullsLast().op("int4_ops")),
	foreignKey({
			columns: [table.organizationId],
			foreignColumns: [organization.id],
			name: "organization_tokens_organization_id_organization_id_fk"
		}).onDelete("cascade"),
]);

export const apiKeys = pgTable("api_keys", {
	id: text().primaryKey().notNull(),
	userId: text("user_id").notNull(),
	name: text(),
	keyHash: text("key_hash").notNull(),
	keyPrefix: text("key_prefix").notNull(),
	createdAt: timestamp("created_at", { mode: 'string' }).defaultNow().notNull(),
	lastUsedAt: timestamp("last_used_at", { mode: 'string' }),
}, (table) => [
	foreignKey({
			columns: [table.userId],
			foreignColumns: [users.id],
			name: "api_keys_user_id_users_id_fk"
		}),
]);

export const tags = pgTable("tags", {
	id: text().primaryKey().notNull(),
	name: text().notNull(),
	color: text().notNull(),
	organizationId: text("organization_id").notNull(),
	userId: text("user_id").notNull(),
	createdAt: timestamp("created_at", { mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_tags_org").using("btree", table.organizationId.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.organizationId],
			foreignColumns: [organization.id],
			name: "tags_organization_id_organization_id_fk"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [users.id],
			name: "tags_user_id_users_id_fk"
		}),
]);

export const organization = pgTable("organization", {
	id: text().primaryKey().notNull(),
	name: text().notNull(),
	slug: text().notNull(),
	logo: text(),
	createdAt: timestamp("created_at", { mode: 'string' }).notNull(),
	metadata: text(),
}, (table) => [
	unique("organization_slug_unique").on(table.slug),
]);

export const invitation = pgTable("invitation", {
	id: text().primaryKey().notNull(),
	organizationId: text("organization_id").notNull(),
	email: text().notNull(),
	role: text(),
	status: text().default('pending').notNull(),
	expiresAt: timestamp("expires_at", { mode: 'string' }).notNull(),
	inviterId: text("inviter_id").notNull(),
	createdAt: timestamp("created_at", { mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.organizationId],
			foreignColumns: [organization.id],
			name: "invitation_organization_id_organization_id_fk"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.inviterId],
			foreignColumns: [users.id],
			name: "invitation_inviter_id_users_id_fk"
		}).onDelete("cascade"),
]);

export const member = pgTable("member", {
	id: text().primaryKey().notNull(),
	organizationId: text("organization_id").notNull(),
	userId: text("user_id").notNull(),
	role: text().default('member').notNull(),
	createdAt: timestamp("created_at", { mode: 'string' }).notNull(),
}, (table) => [
	foreignKey({
			columns: [table.organizationId],
			foreignColumns: [organization.id],
			name: "member_organization_id_organization_id_fk"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [users.id],
			name: "member_user_id_users_id_fk"
		}).onDelete("cascade"),
]);

export const addressBookEntry = pgTable("address_book_entry", {
	id: text().primaryKey().notNull(),
	organizationId: text("organization_id").notNull(),
	label: text().notNull(),
	address: text().notNull(),
	createdAt: timestamp("created_at", { mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { mode: 'string' }).defaultNow().notNull(),
	createdBy: text("created_by"),
}, (table) => [
	index("idx_address_book_org").using("btree", table.organizationId.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.organizationId],
			foreignColumns: [organization.id],
			name: "address_book_entry_organization_id_organization_id_fk"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.createdBy],
			foreignColumns: [users.id],
			name: "address_book_entry_created_by_users_id_fk"
		}).onDelete("set null"),
]);

export const workflows = pgTable("workflows", {
	id: text().primaryKey().notNull(),
	name: text().notNull(),
	description: text(),
	userId: text("user_id").notNull(),
	organizationId: text("organization_id"),
	isAnonymous: boolean("is_anonymous").default(false).notNull(),
	featured: boolean().default(false).notNull(),
	featuredOrder: integer("featured_order").default(0),
	featuredProtocol: text("featured_protocol"),
	featuredProtocolOrder: integer("featured_protocol_order").default(0),
	projectId: text("project_id"),
	tagId: text("tag_id"),
	nodes: jsonb().notNull(),
	edges: jsonb().notNull(),
	visibility: text().default('private').notNull(),
	enabled: boolean().default(false).notNull(),
	createdAt: timestamp("created_at", { mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.userId],
			foreignColumns: [users.id],
			name: "workflows_user_id_users_id_fk"
		}),
	foreignKey({
			columns: [table.organizationId],
			foreignColumns: [organization.id],
			name: "workflows_organization_id_organization_id_fk"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.projectId],
			foreignColumns: [projects.id],
			name: "workflows_project_id_projects_id_fk"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.tagId],
			foreignColumns: [tags.id],
			name: "workflows_tag_id_tags_id_fk"
		}).onDelete("set null"),
]);

export const betaAccessRequests = pgTable("beta_access_requests", {
	id: text().primaryKey().notNull(),
	email: text().notNull(),
	createdAt: timestamp("created_at", { mode: 'string' }).defaultNow().notNull(),
});

export const pendingTransactions = pgTable("pending_transactions", {
	walletAddress: text("wallet_address").notNull(),
	chainId: integer("chain_id").notNull(),
	nonce: integer().notNull(),
	txHash: text("tx_hash").notNull(),
	executionId: text("execution_id").notNull(),
	workflowId: text("workflow_id"),
	gasPrice: text("gas_price"),
	submittedAt: timestamp("submitted_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	confirmedAt: timestamp("confirmed_at", { withTimezone: true, mode: 'string' }),
	status: text().default('pending'),
}, (table) => [
	index("idx_pending_tx_execution").using("btree", table.executionId.asc().nullsLast().op("text_ops")),
	index("idx_pending_tx_status").using("btree", table.walletAddress.asc().nullsLast().op("int4_ops"), table.chainId.asc().nullsLast().op("int4_ops"), table.status.asc().nullsLast().op("text_ops")),
	primaryKey({ columns: [table.walletAddress, table.chainId, table.nonce], name: "pending_transactions_wallet_address_chain_id_nonce_pk"}),
]);

export const projects = pgTable("projects", {
	id: text().primaryKey().notNull(),
	name: text().notNull(),
	description: text(),
	color: text(),
	organizationId: text("organization_id").notNull(),
	userId: text("user_id").notNull(),
	createdAt: timestamp("created_at", { mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_projects_org").using("btree", table.organizationId.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.organizationId],
			foreignColumns: [organization.id],
			name: "projects_organization_id_organization_id_fk"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [users.id],
			name: "projects_user_id_users_id_fk"
		}),
]);

export const explorerConfigs = pgTable("explorer_configs", {
	id: text().primaryKey().notNull(),
	chainId: integer("chain_id").notNull(),
	chainType: text("chain_type").default('evm').notNull(),
	explorerUrl: text("explorer_url"),
	explorerApiType: text("explorer_api_type"),
	explorerApiUrl: text("explorer_api_url"),
	explorerTxPath: text("explorer_tx_path").default('/tx/{hash}'),
	explorerAddressPath: text("explorer_address_path").default('/address/{address}'),
	explorerContractPath: text("explorer_contract_path"),
	createdAt: timestamp("created_at", { mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_explorer_configs_chain_id").using("btree", table.chainId.asc().nullsLast().op("int4_ops")),
	foreignKey({
			columns: [table.chainId],
			foreignColumns: [chains.chainId],
			name: "explorer_configs_chain_id_chains_chain_id_fk"
		}).onDelete("cascade"),
	unique("explorer_configs_chain_id_unique").on(table.chainId),
]);

export const userRpcPreferences = pgTable("user_rpc_preferences", {
	id: text().primaryKey().notNull(),
	userId: text("user_id").notNull(),
	chainId: integer("chain_id").notNull(),
	primaryRpcUrl: text("primary_rpc_url").notNull(),
	fallbackRpcUrl: text("fallback_rpc_url"),
	primaryWssUrl: text("primary_wss_url"),
	fallbackWssUrl: text("fallback_wss_url"),
	createdAt: timestamp("created_at", { mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	uniqueIndex("idx_user_rpc_user_chain").using("btree", table.userId.asc().nullsLast().op("int4_ops"), table.chainId.asc().nullsLast().op("int4_ops")),
	index("idx_user_rpc_user_id").using("btree", table.userId.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [users.id],
			name: "user_rpc_preferences_user_id_users_id_fk"
		}).onDelete("cascade"),
]);

export const chains = pgTable("chains", {
	id: text().primaryKey().notNull(),
	chainId: integer("chain_id").notNull(),
	name: text().notNull(),
	symbol: text().notNull(),
	chainType: text("chain_type").default('evm').notNull(),
	defaultPrimaryRpc: text("default_primary_rpc").notNull(),
	defaultFallbackRpc: text("default_fallback_rpc"),
	defaultPrimaryWss: text("default_primary_wss"),
	defaultFallbackWss: text("default_fallback_wss"),
	isTestnet: boolean("is_testnet").default(false),
	isEnabled: boolean("is_enabled").default(true),
	gasConfig: jsonb("gas_config").default({}),
	createdAt: timestamp("created_at", { mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_chains_chain_id").using("btree", table.chainId.asc().nullsLast().op("int4_ops")),
	unique("chains_chain_id_unique").on(table.chainId),
]);

export const walletLocks = pgTable("wallet_locks", {
	walletAddress: text("wallet_address").notNull(),
	chainId: integer("chain_id").notNull(),
	lockedBy: text("locked_by"),
	lockedAt: timestamp("locked_at", { withTimezone: true, mode: 'string' }),
}, (table) => [
	primaryKey({ columns: [table.walletAddress, table.chainId], name: "wallet_locks_wallet_address_chain_id_pk"}),
]);

export const billingEvents = pgTable("billing_events", {
	id: text().primaryKey().notNull(),
	providerEventId: text("provider_event_id").notNull(),
	type: text().notNull(),
	data: jsonb(),
	processed: boolean().default(false).notNull(),
	createdAt: timestamp("created_at", { mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	unique("billing_events_provider_event_id_unique").on(table.providerEventId),
]);

export const deviceCode = pgTable("device_code", {
	id: text().primaryKey().notNull(),
	deviceCode: text("device_code").notNull(),
	userCode: text("user_code").notNull(),
	userId: text("user_id"),
	expiresAt: timestamp("expires_at", { mode: 'string' }).notNull(),
	status: text().notNull(),
	lastPolledAt: timestamp("last_polled_at", { mode: 'string' }),
	pollingInterval: integer("polling_interval"),
	clientId: text("client_id"),
	scope: text(),
	createdAt: timestamp("created_at", { mode: 'string' }),
	updatedAt: timestamp("updated_at", { mode: 'string' }),
}, (table) => [
	foreignKey({
			columns: [table.userId],
			foreignColumns: [users.id],
			name: "device_code_user_id_users_id_fk"
		}),
]);

export const directExecutions = pgTable("direct_executions", {
	id: text().primaryKey().notNull(),
	organizationId: text("organization_id").notNull(),
	apiKeyId: text("api_key_id").notNull(),
	type: text().notNull(),
	input: jsonb(),
	output: jsonb(),
	status: text().default('pending').notNull(),
	transactionHash: text("transaction_hash"),
	network: text().notNull(),
	error: text(),
	gasUsedWei: text("gas_used_wei"),
	createdAt: timestamp("created_at", { mode: 'string' }).defaultNow().notNull(),
	completedAt: timestamp("completed_at", { mode: 'string' }),
}, (table) => [
	index("idx_direct_executions_org").using("btree", table.organizationId.asc().nullsLast().op("text_ops")),
	index("idx_direct_executions_status").using("btree", table.status.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.organizationId],
			foreignColumns: [organization.id],
			name: "direct_executions_organization_id_organization_id_fk"
		}),
]);

export const executionDebt = pgTable("execution_debt", {
	id: text().primaryKey().notNull(),
	organizationId: text("organization_id").notNull(),
	overageRecordId: text("overage_record_id").notNull(),
	providerInvoiceId: text("provider_invoice_id"),
	debtExecutions: integer("debt_executions").notNull(),
	status: text().default('active').notNull(),
	enforcedAt: timestamp("enforced_at", { mode: 'string' }).notNull(),
	clearedAt: timestamp("cleared_at", { mode: 'string' }),
	createdAt: timestamp("created_at", { mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_execution_debt_org_status").using("btree", table.organizationId.asc().nullsLast().op("text_ops"), table.status.asc().nullsLast().op("text_ops")),
	index("idx_execution_debt_invoice").using("btree", table.providerInvoiceId.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.organizationId],
			foreignColumns: [organization.id],
			name: "execution_debt_organization_id_organization_id_fk"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.overageRecordId],
			foreignColumns: [overageBillingRecords.id],
			name: "execution_debt_overage_record_id_overage_billing_records_id_fk"
		}).onDelete("cascade"),
	unique("execution_debt_overage_record_id_unique").on(table.overageRecordId),
]);

export const keyExportCodes = pgTable("key_export_codes", {
	id: text().primaryKey().notNull(),
	organizationId: text("organization_id").notNull(),
	codeHash: text("code_hash").notNull(),
	expiresAt: timestamp("expires_at", { mode: 'string' }).notNull(),
	createdAt: timestamp("created_at", { mode: 'string' }).defaultNow().notNull(),
	attempts: integer().default(0).notNull(),
}, (table) => [
	foreignKey({
			columns: [table.organizationId],
			foreignColumns: [organization.id],
			name: "key_export_codes_organization_id_organization_id_fk"
		}).onDelete("cascade"),
]);

export const mcpOauthClients = pgTable("mcp_oauth_clients", {
	id: text().primaryKey().notNull(),
	clientId: text("client_id").notNull(),
	clientSecretHash: text("client_secret_hash").notNull(),
	clientName: text("client_name").notNull(),
	redirectUris: jsonb("redirect_uris").notNull(),
	scopes: jsonb().notNull(),
	grantTypes: jsonb("grant_types").notNull(),
	organizationId: text("organization_id"),
	createdAt: timestamp("created_at", { mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	unique("mcp_oauth_clients_client_id_unique").on(table.clientId),
]);

export const mcpOauthRefreshTokens = pgTable("mcp_oauth_refresh_tokens", {
	id: text().primaryKey().notNull(),
	tokenHash: text("token_hash").notNull(),
	clientId: text("client_id").notNull(),
	userId: text("user_id").notNull(),
	organizationId: text("organization_id").notNull(),
	scope: text().notNull(),
	expiresAt: timestamp("expires_at", { mode: 'string' }).notNull(),
	createdAt: timestamp("created_at", { mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_mcp_refresh_tokens_client").using("btree", table.clientId.asc().nullsLast().op("text_ops")),
	index("idx_mcp_refresh_tokens_user").using("btree", table.userId.asc().nullsLast().op("text_ops")),
	unique("mcp_oauth_refresh_tokens_token_hash_unique").on(table.tokenHash),
]);

export const organizationSpendCaps = pgTable("organization_spend_caps", {
	id: text().primaryKey().notNull(),
	organizationId: text("organization_id").notNull(),
	dailyCapWei: text("daily_cap_wei").notNull(),
	createdAt: timestamp("created_at", { mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.organizationId],
			foreignColumns: [organization.id],
			name: "organization_spend_caps_organization_id_organization_id_fk"
		}),
	unique("organization_spend_caps_organization_id_unique").on(table.organizationId),
]);

export const organizationSubscriptions = pgTable("organization_subscriptions", {
	id: text().primaryKey().notNull(),
	organizationId: text("organization_id").notNull(),
	providerCustomerId: text("provider_customer_id"),
	providerSubscriptionId: text("provider_subscription_id"),
	providerPriceId: text("provider_price_id"),
	plan: text().default('free').notNull(),
	tier: text(),
	status: text().default('active').notNull(),
	currentPeriodStart: timestamp("current_period_start", { mode: 'string' }),
	currentPeriodEnd: timestamp("current_period_end", { mode: 'string' }),
	cancelAtPeriodEnd: boolean("cancel_at_period_end").default(false).notNull(),
	billingAlert: text("billing_alert"),
	billingAlertUrl: text("billing_alert_url"),
	createdAt: timestamp("created_at", { mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_org_subscriptions_org").using("btree", table.organizationId.asc().nullsLast().op("text_ops")),
	index("idx_org_subscriptions_provider_sub").using("btree", table.providerSubscriptionId.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.organizationId],
			foreignColumns: [organization.id],
			name: "organization_subscriptions_organization_id_organization_id_fk"
		}).onDelete("cascade"),
	unique("organization_subscriptions_organization_id_unique").on(table.organizationId),
	unique("organization_subscriptions_provider_customer_id_unique").on(table.providerCustomerId),
]);

export const overageBillingRecords = pgTable("overage_billing_records", {
	id: text().primaryKey().notNull(),
	organizationId: text("organization_id").notNull(),
	periodStart: timestamp("period_start", { mode: 'string' }).notNull(),
	periodEnd: timestamp("period_end", { mode: 'string' }).notNull(),
	executionLimit: integer("execution_limit").notNull(),
	totalExecutions: integer("total_executions").notNull(),
	overageCount: integer("overage_count").notNull(),
	overageRateCents: integer("overage_rate_cents").notNull(),
	totalChargeCents: integer("total_charge_cents").notNull(),
	providerInvoiceItemId: text("provider_invoice_item_id"),
	providerInvoiceId: text("provider_invoice_id"),
	status: text().default('pending').notNull(),
	createdAt: timestamp("created_at", { mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_overage_billing_org").using("btree", table.organizationId.asc().nullsLast().op("text_ops")),
	index("idx_overage_billing_status").using("btree", table.status.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.organizationId],
			foreignColumns: [organization.id],
			name: "overage_billing_records_organization_id_organization_id_fk"
		}).onDelete("cascade"),
	unique("overage_billing_org_period").on(table.organizationId, table.periodStart, table.periodEnd),
]);

export const publicTags = pgTable("public_tags", {
	id: text().primaryKey().notNull(),
	name: text().notNull(),
	slug: text().notNull(),
	createdAt: timestamp("created_at", { mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	unique("public_tags_name_unique").on(table.name),
	unique("public_tags_slug_unique").on(table.slug),
]);

export const workflowPublicTags = pgTable("workflow_public_tags", {
	workflowId: text("workflow_id").notNull(),
	publicTagId: text("public_tag_id").notNull(),
}, (table) => [
	index("idx_workflow_public_tags_workflow").using("btree", table.workflowId.asc().nullsLast().op("text_ops")),
	index("idx_workflow_public_tags_tag").using("btree", table.publicTagId.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.workflowId],
			foreignColumns: [workflows.id],
			name: "workflow_public_tags_workflow_id_workflows_id_fk"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.publicTagId],
			foreignColumns: [publicTags.id],
			name: "workflow_public_tags_public_tag_id_public_tags_id_fk"
		}).onDelete("cascade"),
	primaryKey({ columns: [table.workflowId, table.publicTagId], name: "workflow_public_tags_workflow_id_public_tag_id_pk"}),
]);
