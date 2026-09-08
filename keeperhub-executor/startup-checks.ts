import { eq } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/postgres-js";
import { organizationWallets } from "../lib/db/schema";

export function assertHmacSecretSet(): void {
  if (!process.env.INTERNAL_SERVICE_HMAC_SECRET) {
    throw new Error(
      "INTERNAL_SERVICE_HMAC_SECRET is required for internal service authentication"
    );
  }
}

type Db = ReturnType<typeof drizzle>;

const STARTUP_QUERY_TIMEOUT_MS = 10_000;

/**
 * Ephemeral PR environments set K8S_NAMESPACE to "pr-<number>" (see
 * deploy/pr-environment/executor.template.yaml). Staging and production use
 * their own namespaces and are treated as non-ephemeral.
 */
function isEphemeralEnv(): boolean {
  return process.env.K8S_NAMESPACE?.startsWith("pr-") ?? false;
}

function withTimeout<T>(
  operation: PromiseLike<T>,
  timeoutMs: number
): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    Promise.resolve(operation).then(
      (value) => {
        clearTimeout(timer);
        return value;
      },
      (error: unknown) => {
        clearTimeout(timer);
        throw error;
      }
    ),
    new Promise<T>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new Error(`Turnkey startup check timed out after ${timeoutMs}ms`)
          ),
        timeoutMs
      );
    }),
  ]);
}

/**
 * If any org has an active Turnkey wallet, the executor pod (and by extension
 * the runner Jobs it spawns via RUNNER_SYSTEM_ENV_VARS forwarding) must have
 * TURNKEY_API_PUBLIC_KEY and TURNKEY_API_PRIVATE_KEY set. Fail at startup
 * instead of per-job so the regression surfaces on deploy, not on the first
 * Turnkey-backed workflow run.
 *
 * In ephemeral PR environments the check is downgraded to a warning. A PR env
 * may legitimately lack Turnkey credentials or hit a transient secret-sync gap,
 * and because this runs before the health server starts listening, a hard
 * failure here stops the pod from ever becoming ready and fails the whole PR
 * deploy. Staging and production keep the hard failure.
 */
export async function assertTurnkeyEnvForActiveWallets(db: Db): Promise<void> {
  const ephemeral = isEphemeralEnv();

  let rows: { id: string }[];
  try {
    rows = await withTimeout(
      db
        .select({ id: organizationWallets.id })
        .from(organizationWallets)
        .where(eq(organizationWallets.isActive, true))
        .limit(1),
      STARTUP_QUERY_TIMEOUT_MS
    );
  } catch (error) {
    if (ephemeral) {
      console.error(
        "[Executor] Turnkey startup check could not query the database; continuing because this is an ephemeral PR environment:",
        error
      );
      return;
    }
    throw error;
  }

  if (rows.length === 0) {
    return;
  }

  const missing: string[] = [];
  if (!process.env.TURNKEY_API_PUBLIC_KEY) {
    missing.push("TURNKEY_API_PUBLIC_KEY");
  }
  if (!process.env.TURNKEY_API_PRIVATE_KEY) {
    missing.push("TURNKEY_API_PRIVATE_KEY");
  }
  if (!process.env.TURNKEY_ORGANIZATION_ID) {
    missing.push("TURNKEY_ORGANIZATION_ID");
  }

  if (missing.length === 0) {
    return;
  }

  const message =
    `Active Turnkey wallets exist but required env vars are unset: ${missing.join(", ")}. ` +
    "Set these on the executor deployment so they forward to workflow runner Jobs.";

  if (ephemeral) {
    console.error(
      `[Executor] ${message} Continuing because this is an ephemeral PR environment.`
    );
    return;
  }

  throw new Error(message);
}
