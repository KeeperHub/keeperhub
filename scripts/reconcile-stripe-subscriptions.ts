/**
 * Reconcile organization_subscriptions against the billing provider.
 *
 * The webhook handler keeps the table in step with the provider, but only for
 * the events that actually arrive. A missed delivery leaves the row behind, and
 * nothing re-reads the provider afterwards, so a wrong row stays wrong. This
 * script compares the provider's subscription list against the table and prints
 * the SQL that repairs it.
 *
 * The script reads the provider and prints SQL. It never connects to the
 * database. The production database is reachable only from inside the cluster
 * and the provider key must stay there, so one process cannot hold both. The
 * split also puts the exact statements in front of a person before anything is
 * written.
 *
 * Usage:
 *   # 1. list the subscriptions from inside the cluster, so the key stays there
 *   kubectl exec -n keeperhub <app-pod> -- sh -c \
 *     'curl -sS "https://api.stripe.com/v1/subscriptions?status=all&limit=100" \
 *       -u "$STRIPE_SECRET_KEY:"' > subscriptions.json
 *
 *   # 2. turn the list into SQL (dry run: the script ends the file with ROLLBACK)
 *   pnpm tsx scripts/reconcile-stripe-subscriptions.ts < subscriptions.json > repair.sql
 *
 *   # 3. read repair.sql, then run it and check the reported row counts
 *   kubectl exec -i -n keeperhub psql-client -- psql "$DATABASE_URL" -f - < repair.sql
 *
 *   # 4. re-generate with --apply once the counts look right, then run it again
 *   pnpm tsx scripts/reconcile-stripe-subscriptions.ts --apply < subscriptions.json
 *
 * With STRIPE_SECRET_KEY set and nothing piped in, the script calls the provider
 * itself. That is the convenient form for a dev or staging database.
 */

import { Buffer } from "node:buffer";
import process from "node:process";

type StripeSubscription = {
  id: string;
  status: string;
  customer: string | { id: string };
  trial_start: number | null;
  trial_end: number | null;
  ended_at: number | null;
  items: { data: { price: { id: string } }[] };
};

type StripeSubscriptionList = {
  data?: StripeSubscription[];
  has_more?: boolean;
  error?: { message: string };
};

type Repair = {
  subscriptionId: string;
  customerId: string;
  assignments: string[];
  // Conditions that are true only while the row still disagrees with the
  // provider. They make each statement report exactly the rows it had to fix.
  disagreements: string[];
};

// Provider ids and statuses are interpolated into SQL, so anything outside this
// shape aborts the run rather than reaching the database.
const SAFE_ID = /^[A-Za-z0-9_]+$/;
const SAFE_STATUS = /^[a-z_]+$/;

const PAGE_SIZE = 100;

// A subscription in one of these states is over. Stripe also stamps ended_at,
// but only for subscriptions that actually ran, so check both.
const ENDED_STATUSES = new Set(["canceled", "incomplete_expired"]);

function assertSafeId(value: string, what: string): string {
  if (!SAFE_ID.test(value)) {
    throw new Error(`Refusing to build SQL from an unexpected ${what}: ${value}`);
  }
  return value;
}

function assertSafeStatus(value: string): string {
  if (!SAFE_STATUS.test(value)) {
    throw new Error(`Refusing to build SQL from an unexpected status: ${value}`);
  }
  return value;
}

function customerIdOf(subscription: StripeSubscription): string | undefined {
  const { customer } = subscription;
  return typeof customer === "string" ? customer : customer?.id;
}

/** Epoch seconds as the naive UTC literal the timestamp columns hold. */
function toSqlTimestamp(epochSeconds: number): string {
  const iso = new Date(epochSeconds * 1000).toISOString();
  return `TIMESTAMP '${iso.slice(0, 19).replace("T", " ")}'`;
}

function hasEnded(subscription: StripeSubscription): boolean {
  return (
    subscription.ended_at !== null || ENDED_STATUSES.has(subscription.status)
  );
}

function buildRepair(subscription: StripeSubscription): Repair | undefined {
  const customerId = customerIdOf(subscription);
  if (!customerId) {
    return undefined;
  }

  const subscriptionId = assertSafeId(subscription.id, "subscription id");
  assertSafeId(customerId, "customer id");
  const status = assertSafeStatus(subscription.status);
  const priceId = subscription.items?.data?.[0]?.price?.id;

  const assignments = [
    `status = '${status}'`,
    `provider_subscription_id = '${subscriptionId}'`,
  ];
  const disagreements = [
    `status IS DISTINCT FROM '${status}'`,
    `provider_subscription_id IS DISTINCT FROM '${subscriptionId}'`,
  ];

  if (priceId) {
    assertSafeId(priceId, "price id");
    assignments.push(`provider_price_id = '${priceId}'`);
    disagreements.push(`provider_price_id IS DISTINCT FROM '${priceId}'`);
  }

  // Only ever fill a missing trial stamp. Ours records when our checkout began
  // and the provider's records when the trial did, so they differ by seconds on
  // rows that are already correct.
  if (subscription.trial_start !== null) {
    const startedAt = toSqlTimestamp(subscription.trial_start);
    assignments.push(`trial_started_at = COALESCE(trial_started_at, ${startedAt})`);
    disagreements.push("trial_started_at IS NULL");
  }

  // A subscription that is over leaves the org on the free plan. Every
  // entitlement read decides access from plan alone, so this is what actually
  // revokes it.
  if (hasEnded(subscription)) {
    assignments.push("plan = 'free'", "tier = NULL");
    disagreements.push("plan IS DISTINCT FROM 'free'", "tier IS NOT NULL");
  }

  assignments.push("updated_at = now()");

  return { subscriptionId, customerId, assignments, disagreements };
}

function renderUpdate(repair: Repair): string {
  const { subscriptionId, customerId, assignments, disagreements } = repair;
  return [
    `-- ${subscriptionId}`,
    "UPDATE organization_subscriptions SET",
    assignments.map((a) => `  ${a}`).join(",\n"),
    `WHERE provider_customer_id = '${customerId}'`,
    // Never take a row that already belongs to another subscription: the org
    // subscribed again, and that newer row is the correct one.
    `  AND (provider_subscription_id IS NULL OR provider_subscription_id = '${subscriptionId}')`,
    `  AND (${disagreements.join("\n       OR ")});`,
  ].join("\n");
}

function renderUnreachableReport(repairs: Repair[]): string {
  const values = repairs
    .map((r) => `    ('${r.subscriptionId}', '${r.customerId}')`)
    .join(",\n");
  return [
    "-- Subscriptions this repair could not reach. Each one needs a decision.",
    "SELECT v.subscription_id, v.customer_id,",
    "  CASE WHEN s.id IS NULL THEN 'no organization row for this customer'",
    "       ELSE 'row already belongs to ' || s.provider_subscription_id END AS reason",
    "FROM (VALUES",
    values,
    "  ) AS v(subscription_id, customer_id)",
    "LEFT JOIN organization_subscriptions s ON s.provider_customer_id = v.customer_id",
    "WHERE s.id IS NULL",
    "   OR (s.provider_subscription_id IS NOT NULL",
    "       AND s.provider_subscription_id <> v.subscription_id);",
  ].join("\n");
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseList(raw: string): StripeSubscriptionList {
  const parsed = JSON.parse(raw) as StripeSubscriptionList;
  if (parsed.error) {
    throw new Error(`The provider returned an error: ${parsed.error.message}`);
  }
  if (!Array.isArray(parsed.data)) {
    throw new Error("The provider response carries no subscription list");
  }
  return parsed;
}

async function fetchFromProvider(
  secretKey: string
): Promise<StripeSubscription[]> {
  const all: StripeSubscription[] = [];
  let startingAfter: string | undefined;

  for (;;) {
    const url = new URL("https://api.stripe.com/v1/subscriptions");
    url.searchParams.set("status", "all");
    url.searchParams.set("limit", String(PAGE_SIZE));
    if (startingAfter) {
      url.searchParams.set("starting_after", startingAfter);
    }

    const response = await fetch(url, {
      headers: {
        Authorization: `Basic ${Buffer.from(`${secretKey}:`).toString("base64")}`,
      },
    });
    const page = parseList(await response.text());
    const data = page.data ?? [];
    all.push(...data);

    const last = data.at(-1);
    if (!(page.has_more && last)) {
      return all;
    }
    startingAfter = last.id;
  }
}

async function loadSubscriptions(): Promise<StripeSubscription[]> {
  if (!process.stdin.isTTY) {
    const raw = (await readStdin()).trim();
    if (raw.length > 0) {
      const page = parseList(raw);
      if (page.has_more) {
        throw new Error(
          `The piped list is truncated (has_more is true). Page through the provider or raise limit above ${PAGE_SIZE}.`
        );
      }
      return page.data ?? [];
    }
  }

  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) {
    throw new Error(
      "Pipe a subscription list in, or set STRIPE_SECRET_KEY to let the script fetch one"
    );
  }
  return await fetchFromProvider(secretKey);
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const subscriptions = await loadSubscriptions();

  const repairs: Repair[] = [];
  const skipped: string[] = [];
  for (const subscription of subscriptions) {
    const repair = buildRepair(subscription);
    if (repair) {
      repairs.push(repair);
    } else {
      skipped.push(subscription.id);
    }
  }

  const lines = [
    "-- Generated by scripts/reconcile-stripe-subscriptions.ts",
    `-- ${subscriptions.length} subscription(s) read from the provider, ${repairs.length} statement(s) below.`,
    "-- Each UPDATE reports the rows that actually disagreed, so a count of 0 means that",
    "-- subscription was already correct.",
    apply
      ? "-- Ends with COMMIT."
      : "-- Dry run: ends with ROLLBACK. Re-generate with --apply to keep the changes.",
    "",
    "BEGIN;",
    "",
  ];

  if (skipped.length > 0) {
    lines.push(
      `-- Skipped, no customer on the subscription: ${skipped.join(", ")}`,
      ""
    );
  }

  for (const repair of repairs) {
    lines.push(renderUpdate(repair), "");
  }

  if (repairs.length > 0) {
    lines.push(renderUnreachableReport(repairs), "");
  }

  lines.push(apply ? "COMMIT;" : "ROLLBACK;");

  console.log(lines.join("\n"));
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
  process.exitCode = 1;
});
