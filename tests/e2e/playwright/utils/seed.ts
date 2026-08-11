import { randomBytes, scrypt } from "node:crypto";
import type postgres from "postgres";
import { getDbConnection } from "./connection";

// ---------------------------------------------------------------------------
// Password hashing (scrypt, compatible with Better Auth / @noble/hashes/scrypt)
// ---------------------------------------------------------------------------

const SCRYPT_CONFIG = { N: 16_384, r: 16, p: 1, dkLen: 64 } as const;

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function scryptAsync(
  password: string,
  salt: string,
  keylen: number
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password,
      salt,
      keylen,
      {
        N: SCRYPT_CONFIG.N,
        r: SCRYPT_CONFIG.r,
        p: SCRYPT_CONFIG.p,
        maxmem: 128 * SCRYPT_CONFIG.N * SCRYPT_CONFIG.r * 2,
      },
      (err, derivedKey) => {
        if (err) {
          reject(err);
        } else {
          resolve(derivedKey);
        }
      }
    );
  });
}

async function hashPassword(password: string): Promise<string> {
  const saltBytes = randomBytes(16);
  const salt = bytesToHex(saltBytes);
  const key = await scryptAsync(
    password.normalize("NFKC"),
    salt,
    SCRYPT_CONFIG.dkLen
  );
  return `${salt}:${bytesToHex(key)}`;
}

// ---------------------------------------------------------------------------
// ID generation (lowercase alphanumeric, 21 chars)
// ---------------------------------------------------------------------------

const ID_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";
const ID_LENGTH = 21;

// Rejection sampling avoids modulo bias: 256 is not a multiple of 36, so
// mapping raw bytes with `% 36` would over-represent the first four symbols.
// 252 = floor(256 / 36) * 36 is the largest unbiased cutoff; reject above it.
const ID_UNBIASED_CUTOFF = 252;

function generateId(): string {
  let id = "";
  while (id.length < ID_LENGTH) {
    const byte = randomBytes(1)[0];
    if (byte >= ID_UNBIASED_CUTOFF) {
      continue;
    }
    id += ID_ALPHABET[byte % ID_ALPHABET.length];
  }
  return id;
}

// ---------------------------------------------------------------------------
// Test user definitions
// ---------------------------------------------------------------------------

const TEST_PASSWORD = "TestPassword123!";

type TestUserConfig = {
  email: string;
  name: string;
  orgSlug: string;
  orgName: string;
  password?: string;
};

const ANALYTICS_PASSWORD = "TestAnalytics123!";

const PERSISTENT_USERS: TestUserConfig[] = [
  {
    email: "pr-test-do-not-delete@techops.services",
    name: "E2E Test User",
    orgSlug: "e2e-test-org",
    orgName: "E2E Test Organization",
  },
  {
    email: "pr-test-inviter@techops.services",
    name: "E2E Inviter",
    orgSlug: "e2e-test-inviter-org",
    orgName: "E2E Inviter Organization",
  },
  {
    email: "pr-test-member@techops.services",
    name: "E2E Member",
    orgSlug: "e2e-test-member-org",
    orgName: "E2E Member Organization",
  },
  {
    email: "pr-test-bystander@techops.services",
    name: "E2E Bystander",
    orgSlug: "e2e-test-bystander-org",
    orgName: "E2E Bystander Organization",
  },
  {
    email: "test-analytics@techops.services",
    name: "E2E Analytics",
    orgSlug: "e2e-test-analytics-org",
    orgName: "E2E Analytics Organization",
    password: ANALYTICS_PASSWORD,
  },
  {
    // Org carries a 'pro' plan (see seedPersistentTestUsers) so tests that need
    // feature-gated actions (HTTP Request, Send Webhook, Database Query, Code)
    // can use them. e2e-test-org stays free for the billing/free-limit tests.
    email: "pr-test-pro@techops.services",
    name: "E2E Pro User",
    orgSlug: "e2e-test-pro-org",
    orgName: "E2E Pro Organization",
  },
];

const PRO_ORG_SLUG = "e2e-test-pro-org";

const PERSISTENT_EMAILS = PERSISTENT_USERS.map((u) => u.email);

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

async function ensureUser(
  sql: ReturnType<typeof postgres>,
  email: string,
  name: string
): Promise<string> {
  const existing = await sql`
    SELECT id FROM users WHERE email = ${email} LIMIT 1
  `;
  if (existing.length > 0) {
    const existingId = existing[0].id as string;
    // Persistent users represent returning, already-onboarded accounts. Keep
    // the flag set so the welcome gating lands them on the canvas, not the
    // onboarding wizard.
    await sql`
      UPDATE users SET onboarding_completed = true WHERE id = ${existingId}
    `;
    return existingId;
  }

  const id = generateId();
  const now = new Date();
  await sql`
    INSERT INTO users (id, name, email, email_verified, onboarding_completed, created_at, updated_at)
    VALUES (${id}, ${name}, ${email}, true, true, ${now}, ${now})
  `;
  return id;
}

async function ensureCredentialAccount(
  sql: ReturnType<typeof postgres>,
  userId: string,
  password: string
): Promise<void> {
  const existing = await sql`
    SELECT id FROM accounts
    WHERE user_id = ${userId} AND provider_id = 'credential'
    LIMIT 1
  `;
  if (existing.length > 0) {
    return;
  }

  const hashedPassword = await hashPassword(password);
  const now = new Date();
  await sql`
    INSERT INTO accounts (id, account_id, provider_id, user_id, password, created_at, updated_at)
    VALUES (${generateId()}, ${userId}, 'credential', ${userId}, ${hashedPassword}, ${now}, ${now})
  `;
}

async function ensureOrganization(
  sql: ReturnType<typeof postgres>,
  slug: string,
  name: string
): Promise<string> {
  const existing = await sql`
    SELECT id FROM organization WHERE slug = ${slug} LIMIT 1
  `;
  if (existing.length > 0) {
    return existing[0].id as string;
  }

  const id = generateId();
  await sql`
    INSERT INTO organization (id, name, slug, created_at)
    VALUES (${id}, ${name}, ${slug}, ${new Date()})
  `;
  return id;
}

async function ensureMembership(
  sql: ReturnType<typeof postgres>,
  userId: string,
  orgId: string,
  role: string
): Promise<void> {
  const existing = await sql`
    SELECT id FROM member
    WHERE user_id = ${userId} AND organization_id = ${orgId}
    LIMIT 1
  `;
  if (existing.length > 0) {
    return;
  }

  await sql`
    INSERT INTO member (id, organization_id, user_id, role, created_at)
    VALUES (${generateId()}, ${orgId}, ${userId}, ${role}, ${new Date()})
  `;
}

async function ensureProSubscription(
  sql: ReturnType<typeof postgres>,
  orgId: string
): Promise<void> {
  const existing = await sql`
    SELECT id FROM organization_subscriptions
    WHERE organization_id = ${orgId} LIMIT 1
  `;
  if (existing.length > 0) {
    await sql`
      UPDATE organization_subscriptions SET plan = 'pro', status = 'active'
      WHERE organization_id = ${orgId}
    `;
    return;
  }
  const now = new Date();
  await sql`
    INSERT INTO organization_subscriptions (
      id, organization_id, plan, status, created_at, updated_at
    ) VALUES (
      ${generateId()}, ${orgId}, 'pro', 'active', ${now}, ${now}
    )
  `;
}

// ---------------------------------------------------------------------------
// Public: seedPersistentTestUsers
// ---------------------------------------------------------------------------

export async function seedPersistentTestUsers(): Promise<void> {
  const sql = getDbConnection();
  try {
    const results: Array<{ userId: string; orgId: string }> = [];
    let proOrgId: string | null = null;

    for (const config of PERSISTENT_USERS) {
      const userId = await ensureUser(sql, config.email, config.name);
      await ensureCredentialAccount(
        sql,
        userId,
        config.password ?? TEST_PASSWORD
      );
      const orgId = await ensureOrganization(
        sql,
        config.orgSlug,
        config.orgName
      );
      await ensureMembership(sql, userId, orgId, "owner");
      results.push({ userId, orgId });
      if (config.orgSlug === PRO_ORG_SLUG) {
        proOrgId = orgId;
      }
    }

    // Cross-org: member (index 2) is a member of inviter's org (index 1)
    const inviter = results[1];
    const member = results[2];
    await ensureMembership(sql, member.userId, inviter.orgId, "member");

    // The pro user's org carries a 'pro' plan so feature-gated actions resolve.
    if (proOrgId) {
      await ensureProSubscription(sql, proOrgId);
    }
  } finally {
    await sql.end();
  }
}

// ---------------------------------------------------------------------------
// Analytics seed data
// ---------------------------------------------------------------------------

const ANALYTICS_EMAIL = "test-analytics@techops.services";
const ANALYTICS_SEED_PREFIX = "[Analytics Seed]";
const ANALYTICS_NETWORKS = ["ethereum", "base", "polygon", "sepolia"] as const;

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomChoice<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randomHex(length: number): string {
  const chars = "0123456789abcdef";
  let result = "";
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

function hoursAgo(hours: number): Date {
  return new Date(Date.now() - hours * 60 * 60 * 1000);
}

function randomDateBetween(start: Date, end: Date): Date {
  return new Date(
    start.getTime() + Math.random() * (end.getTime() - start.getTime())
  );
}

function realisticGasWei(network: string): string {
  const gasUnits = randomInt(21_000, 350_000);
  const gasPriceGwei: Record<string, [number, number]> = {
    ethereum: [15, 80],
    base: [0.01, 0.1],
    polygon: [30, 200],
    sepolia: [1, 10],
  };
  const [lo, hi] = gasPriceGwei[network] ?? [10, 50];
  const priceGwei = lo + Math.random() * (hi - lo);
  const priceWei = BigInt(Math.round(priceGwei * 1e9));
  return (BigInt(gasUnits) * priceWei).toString();
}

type Db = ReturnType<typeof postgres>;

const CHAIN_MAP: Record<string, string> = {
  ethereum: "1",
  base: "8453",
  polygon: "137",
  sepolia: "11155111",
};

const STEP_NODE_TYPES = [
  "web3:read-contract",
  "web3:write-contract",
  "condition",
  "http-request",
] as const;

function resolveStepStatus(
  execStatus: string,
  stepIndex: number,
  stepCount: number
): string {
  if (execStatus === "error" && stepIndex === stepCount - 1) {
    return "error";
  }
  if (execStatus === "running" && stepIndex === stepCount - 1) {
    return "running";
  }
  if (execStatus === "pending" && stepIndex > 1) {
    return "pending";
  }
  return "success";
}

function buildStepInput(nodeType: string, chainId: string): string | null {
  if (nodeType !== "web3:write-contract") {
    return null;
  }
  return JSON.stringify({
    network: chainId,
    contractAddress: `0x${randomHex(40)}`,
    actionType: "web3/write-contract",
  });
}

function buildStepOutput(gasUsedWei: string | null): string | null {
  if (gasUsedWei === null) {
    return null;
  }
  return JSON.stringify({
    success: true,
    transactionHash: `0x${randomHex(64)}`,
    gasUsed: gasUsedWei,
  });
}

async function seedStepLogs(
  sql: Db,
  execId: string,
  execStatus: string,
  startedAt: Date
): Promise<void> {
  let currentTime = startedAt.getTime();
  const stepCount = randomInt(3, 5);

  for (let s = 0; s < stepCount; s++) {
    const nodeType = s === 0 ? "trigger" : randomChoice(STEP_NODE_TYPES);
    const stepDuration = randomInt(50, 1500);
    const stepStartedAt = new Date(currentTime);
    const stepStatus = resolveStepStatus(execStatus, s, stepCount);
    const isTerminal = stepStatus === "pending" || stepStatus === "running";
    const isWrite = nodeType === "web3:write-contract";
    const network = isWrite ? randomChoice(ANALYTICS_NETWORKS) : null;
    const chainId = CHAIN_MAP[network ?? "sepolia"] ?? "11155111";
    // Computed once and mirrored into the output JSONB and the denormalised
    // gas_used_wei column the analytics network breakdown reads.
    const gasUsedWei =
      isWrite && stepStatus === "success"
        ? String(randomInt(21_000, 350_000))
        : null;

    await sql.unsafe(
      `INSERT INTO workflow_execution_logs (
        id, execution_id, node_id, node_name, node_type, status,
        started_at, completed_at, duration, error, input, output,
        network, gas_used_wei
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::jsonb, $13, $14)`,
      [
        generateId(),
        execId,
        `node-${s + 1}`,
        `Step ${s + 1}`,
        nodeType,
        stepStatus,
        stepStartedAt,
        isTerminal ? null : new Date(currentTime + stepDuration),
        isTerminal ? null : String(stepDuration),
        stepStatus === "error" ? "Contract call reverted" : null,
        buildStepInput(nodeType, chainId),
        buildStepOutput(gasUsedWei),
        isWrite ? chainId : null,
        gasUsedWei,
      ]
    );
    currentTime += stepDuration + randomInt(10, 100);
  }
}

async function seedWorkflowExecutions(
  sql: Db,
  userId: string,
  workflowIds: string[],
  sevenDaysAgo: Date,
  now: Date
): Promise<void> {
  for (let i = 0; i < 30; i++) {
    const execId = generateId();
    const workflowId = randomChoice(workflowIds);
    const startedAt = randomDateBetween(sevenDaysAgo, now);
    const roll = Math.random();
    let status: string;
    let completedAt: Date | null = null;
    let duration: string | null = null;
    const totalSteps = String(randomInt(3, 5));

    if (roll < 0.7) {
      status = "success";
      const ms = randomInt(500, 5000);
      duration = String(ms);
      completedAt = new Date(startedAt.getTime() + ms);
    } else if (roll < 0.9) {
      status = "error";
      const ms = randomInt(200, 3000);
      duration = String(ms);
      completedAt = new Date(startedAt.getTime() + ms);
    } else {
      status = Math.random() < 0.5 ? "running" : "pending";
    }

    let completedSteps: string;
    if (status === "success") {
      completedSteps = totalSteps;
    } else if (status === "error") {
      completedSteps = String(randomInt(1, Number(totalSteps) - 1));
    } else {
      completedSteps = String(randomInt(0, 2));
    }

    await sql.unsafe(
      `INSERT INTO workflow_executions (
        id, workflow_id, user_id, status, error, started_at, completed_at,
        duration, total_steps, completed_steps
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        execId,
        workflowId,
        userId,
        status,
        status === "error" ? "Step execution failed: timeout exceeded" : null,
        startedAt,
        completedAt,
        duration,
        totalSteps,
        completedSteps,
      ]
    );

    await seedStepLogs(sql, execId, status, startedAt);
  }
}

async function seedDirectExecutions(
  sql: Db,
  orgId: string,
  sevenDaysAgo: Date,
  now: Date
): Promise<void> {
  const directTypes = [
    "transfer",
    "contract-call",
    "check-and-execute",
  ] as const;
  const fakeApiKeyId = generateId();
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);

  for (let i = 0; i < 40; i++) {
    const network = randomChoice(ANALYTICS_NETWORKS);
    const createdAt =
      i < 8
        ? randomDateBetween(todayStart, now)
        : randomDateBetween(sevenDaysAgo, now);
    const roll = Math.random();
    let status: string;
    let completedAt: Date | null = null;
    let gasUsedWei: string | null = null;

    if (roll < 0.75) {
      status = "completed";
      completedAt = new Date(createdAt.getTime() + randomInt(1000, 8000));
      gasUsedWei = realisticGasWei(network);
    } else if (roll < 0.95) {
      status = "failed";
      completedAt = new Date(createdAt.getTime() + randomInt(500, 3000));
    } else {
      status = "pending";
    }

    await sql.unsafe(
      `INSERT INTO direct_executions (
        id, organization_id, api_key_id, type, status,
        transaction_hash, network, error, gas_used_wei, created_at, completed_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        generateId(),
        orgId,
        fakeApiKeyId,
        randomChoice(directTypes),
        status,
        status === "pending" ? null : `0x${randomHex(64)}`,
        network,
        status === "failed" ? "Transaction reverted: insufficient funds" : null,
        gasUsedWei,
        createdAt,
        completedAt,
      ]
    );
  }
}

export async function seedAnalyticsData(): Promise<void> {
  const sql = getDbConnection();
  try {
    const userResult = await sql`
      SELECT id FROM users WHERE email = ${ANALYTICS_EMAIL} LIMIT 1
    `;
    if (userResult.length === 0) {
      return;
    }
    const userId = userResult[0].id as string;

    const orgResult = await sql`
      SELECT organization_id FROM member WHERE user_id = ${userId} LIMIT 1
    `;
    if (orgResult.length === 0) {
      return;
    }
    const orgId = orgResult[0].organization_id as string;

    const existing = await sql`
      SELECT id FROM workflows
      WHERE organization_id = ${orgId} AND name LIKE ${`${ANALYTICS_SEED_PREFIX}%`}
      LIMIT 1
    `;
    if (existing.length > 0) {
      return;
    }

    const now = new Date();
    const sevenDaysAgo = hoursAgo(7 * 24);

    // Create seed workflows
    const workflowNames = [
      `${ANALYTICS_SEED_PREFIX} USDC Monitor`,
      `${ANALYTICS_SEED_PREFIX} ETH Price Alert`,
      `${ANALYTICS_SEED_PREFIX} LP Rebalancer`,
    ];
    const workflowIds: string[] = [];
    const nodes = JSON.stringify([
      {
        id: "trigger-1",
        type: "trigger",
        position: { x: 100, y: 200 },
        data: {
          label: "Manual Trigger",
          type: "trigger",
          config: { triggerType: "Manual" },
          status: "idle",
        },
      },
      {
        id: "action-1",
        type: "action",
        position: { x: 350, y: 200 },
        data: {
          label: "Check Balance",
          type: "action",
          config: {
            actionType: "web3/check-balance",
            network: "1",
            address: "0xde0B295669a9FD93d5F28D9Ec85E40f4cb697BAe",
          },
          status: "idle",
        },
      },
    ]);
    const edges = JSON.stringify([
      { id: "e1", source: "trigger-1", target: "action-1" },
    ]);

    for (const name of workflowNames) {
      const id = generateId();
      await sql.unsafe(
        `INSERT INTO workflows (
          id, name, description, user_id, organization_id, is_anonymous,
          nodes, edges, visibility, enabled, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, false, $6::jsonb, $7::jsonb, 'private', true, $8, $9)`,
        [
          id,
          name,
          "Seeded for analytics testing",
          userId,
          orgId,
          nodes,
          edges,
          now,
          now,
        ]
      );
      workflowIds.push(id);
    }

    await seedWorkflowExecutions(sql, userId, workflowIds, sevenDaysAgo, now);
    await seedDirectExecutions(sql, orgId, sevenDaysAgo, now);

    // Create spend cap
    const capExists = await sql`
      SELECT id FROM organization_spend_caps WHERE organization_id = ${orgId} LIMIT 1
    `;
    if (capExists.length === 0) {
      await sql.unsafe(
        `INSERT INTO organization_spend_caps (
          id, organization_id, daily_cap_wei, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5)`,
        [generateId(), orgId, (BigInt(5) * BigInt(1e16)).toString(), now, now]
      );
    }
  } finally {
    await sql.end();
  }
}

// ---------------------------------------------------------------------------
// Public: cleanupPersistentTestUsers
// ---------------------------------------------------------------------------

export async function cleanupPersistentTestUsers(): Promise<void> {
  const sql = getDbConnection();
  try {
    // Deleting test users drives security_audit_log's FK to null actor_user_id,
    // which the append-only trigger rejects. This cleanup connection runs as the
    // postgres superuser (max: 1), so disable replication-role triggers on it to
    // remove test data without tripping the guard.
    await sql`SET session_replication_role = 'replica'`;
    const testUsers = await sql`
      SELECT id FROM users WHERE email IN ${sql(PERSISTENT_EMAILS)}
    `;
    if (testUsers.length === 0) {
      return;
    }

    const userIds = testUsers.map((u) => u.id as string);

    const ownedOrgs = await sql`
      SELECT DISTINCT organization_id AS id FROM member
      WHERE user_id IN ${sql(userIds)} AND role = 'owner'
    `;
    const orgIds = ownedOrgs.map((o) => o.id as string);

    // Collect workflows owned by persistent users OR in their orgs
    // (org deletion cascades to workflows, but executions block that cascade)
    const workflowQuery =
      orgIds.length > 0
        ? sql`
          SELECT id FROM workflows
          WHERE user_id IN ${sql(userIds)}
             OR organization_id IN ${sql(orgIds)}
        `
        : sql`SELECT id FROM workflows WHERE user_id IN ${sql(userIds)}`;
    const testWorkflows = await workflowQuery;
    const workflowIds = testWorkflows.map((w) => w.id as string);

    // 1. Workflow data
    if (workflowIds.length > 0) {
      await sql`
        DELETE FROM workflow_execution_logs WHERE execution_id IN (
          SELECT id FROM workflow_executions WHERE workflow_id IN ${sql(workflowIds)}
        )
      `;
      await sql`DELETE FROM workflow_executions WHERE workflow_id IN ${sql(workflowIds)}`;
      await sql`DELETE FROM workflow_schedules WHERE workflow_id IN ${sql(workflowIds)}`;
      await sql`DELETE FROM workflows WHERE id IN ${sql(workflowIds)}`;
    }

    // 2. Organization wallets (DB only)
    await sql`DELETE FROM organization_wallets WHERE user_id IN ${sql(userIds)}`;

    // 3. Integrations, API keys, preferences
    // integrations uses created_by (not user_id) per schema
    await sql`DELETE FROM integrations WHERE created_by IN ${sql(userIds)}`;
    await sql`DELETE FROM api_keys WHERE user_id IN ${sql(userIds)}`;
    await sql`DELETE FROM user_rpc_preferences WHERE user_id IN ${sql(userIds)}`;

    if (orgIds.length > 0) {
      await sql`DELETE FROM direct_executions WHERE organization_id IN ${sql(orgIds)}`;
      await sql`DELETE FROM organization_spend_caps WHERE organization_id IN ${sql(orgIds)}`;
      await sql`DELETE FROM address_book_entry WHERE organization_id IN ${sql(orgIds)}`;
      await sql`DELETE FROM organization_api_keys WHERE organization_id IN ${sql(orgIds)}`;
      await sql`DELETE FROM organization_tokens WHERE organization_id IN ${sql(orgIds)}`;
      await sql`DELETE FROM projects WHERE organization_id IN ${sql(orgIds)}`;
      await sql`DELETE FROM tags WHERE organization_id IN ${sql(orgIds)}`;
      await sql`DELETE FROM integrations WHERE organization_id IN ${sql(orgIds)}`;
    }

    // 4. Invitations
    if (orgIds.length > 0) {
      await sql`DELETE FROM invitation WHERE organization_id IN ${sql(orgIds)}`;
    }
    await sql`DELETE FROM invitation WHERE email IN ${sql(PERSISTENT_EMAILS)}`;

    // 5. Members
    if (orgIds.length > 0) {
      await sql`DELETE FROM member WHERE organization_id IN ${sql(orgIds)}`;
    }
    await sql`DELETE FROM member WHERE user_id IN ${sql(userIds)}`;

    // 6. Sessions and accounts
    await sql`DELETE FROM sessions WHERE user_id IN ${sql(userIds)}`;
    await sql`DELETE FROM accounts WHERE user_id IN ${sql(userIds)}`;

    // 7. Organizations
    if (orgIds.length > 0) {
      await sql`DELETE FROM organization WHERE id IN ${sql(orgIds)}`;
    }

    // 8. Users
    await sql`DELETE FROM users WHERE id IN ${sql(userIds)}`;

    // 9. Verifications
    await sql`
      DELETE FROM verifications
      WHERE identifier LIKE 'email-verification-otp-pr-test-%'
         OR identifier LIKE 'email-verification-otp-test-analytics%'
    `;
  } finally {
    await sql.end();
  }
}
