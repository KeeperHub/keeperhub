#!/usr/bin/env node
// Run with: pnpm exec tsx scripts/pyth-demo/run.cjs --help
const { spawn } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");
const Module = require("node:module");
const root = path.resolve(__dirname, "../..");
process.chdir(root);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const localHosts = ["localhost", "127.0.0.1", "[::1]"];

if (process.argv.includes("--help")) {
  console.log(`Live Pyth backend demo (no frontend).
Usage: pnpm exec tsx scripts/pyth-demo/run.cjs
Load your local development environment into the shell first.
Requires a migrated local PostgreSQL database whose name ends in _pyth,
local SQS-compatible emulator, local Redis, and installed event-tracker dependencies.
Required: DATABASE_URL, AWS_ENDPOINT_URL, SQS_QUEUE_URL, REDIS_HOST,
REDIS_PORT, PYTH_API_KEY, INTERNAL_SERVICE_HMAC_SECRET,
AGENTIC_WALLET_HMAC_KMS_KEY, and normal KeeperHub local backend secrets.
The runner creates two dedicated demo workflows, consumes real live ETH prices,
checks actual action output, and tests two signed queue redeliveries.
It disables its workflows and stops its child processes on exit.
Evidence and logs are written under tmp/pyth-demo/<unique-run-id>.
It does not provision containers, migrate a database, or deploy anything.`);
  process.exit(0);
}

function validateEnvironment() {
  const database = new URL(process.env.DATABASE_URL);
  if (
    !localHosts.includes(database.hostname) ||
    !database.pathname.endsWith("_pyth")
  ) {
    throw Error("Use an isolated local database whose name ends in _pyth");
  }
  for (const name of ["AWS_ENDPOINT_URL", "SQS_QUEUE_URL"]) {
    const url = new URL(process.env[name]);
    if (!localHosts.includes(url.hostname) || url.protocol !== "http:") {
      throw Error(`${name} must target a local HTTP queue emulator`);
    }
  }
  if (!localHosts.includes(process.env.REDIS_HOST))
    throw Error("REDIS_HOST must be local");
  for (const name of [
    "REDIS_PORT",
    "PYTH_API_KEY",
    "INTERNAL_SERVICE_HMAC_SECRET",
    "AGENTIC_WALLET_HMAC_KMS_KEY",
  ]) {
    if (!process.env[name]) throw Error(`Missing ${name}`);
  }
}

// The standalone executor image also removes this Next-only import marker.
// Scope the marker shim to this demo process; never edit shared node_modules.
const originalLoad = Module._load;
Module._load = function (id, ...args) {
  if (id === "server-only") return {};
  return originalLoad.call(this, id, ...args);
};
require("tsx/cjs");

async function backend() {
  const { createServer } = require("node:http");
  const pyth = require("../../app/api/internal/pyth-triggers/route.ts");
  const events = require("../../app/api/workflows/events/route.ts");
  createServer(async (incoming, outgoing) => {
    try {
      const url = new URL(incoming.url || "/", "http://localhost:3110");
      const chunks = [];
      let size = 0;
      for await (const chunk of incoming) {
        size += chunk.length;
        if (size > 16384) {
          outgoing.writeHead(413).end();
          return;
        }
        chunks.push(chunk);
      }
      const method = incoming.method || "GET";
      const headers = new Headers();
      for (const [key, value] of Object.entries(incoming.headers)) {
        if (typeof value === "string") headers.set(key, value);
      }
      const handler =
        url.pathname === "/api/internal/pyth-triggers"
          ? method === "GET"
            ? pyth.GET
            : method === "POST"
              ? pyth.POST
              : null
          : url.pathname === "/api/workflows/events" && method === "GET"
            ? events.GET
            : null;
      if (!handler) {
        outgoing.writeHead(404).end();
        return;
      }
      const request = new Request(url, {
        method,
        headers,
        ...(method === "POST"
          ? { body: Buffer.concat(chunks).toString("utf8") }
          : {}),
      });
      const response = await handler(request);
      outgoing.writeHead(
        response.status,
        Object.fromEntries(response.headers.entries()),
      );
      outgoing.end(await response.text());
    } catch {
      outgoing.writeHead(500).end();
      console.error("Demo route handler failed; inspect the backend log.");
    }
  }).listen(3110, "127.0.0.1");
  require("../../keeperhub-executor/index.ts");
}

function checkPort(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", () =>
      reject(Error(`Port ${port} is occupied; stop the previous demo`)),
    );
    server.listen(port, "127.0.0.1", () => server.close(resolve));
  });
}

async function main() {
  validateEnvironment();
  Object.assign(process.env, {
    TZ: "UTC",
    EXECUTION_MODE: "in-process",
    SQS_HMAC_MODE: "enforce",
    NEXT_PUBLIC_BILLING_ENABLED: "false",
    KEEPERHUB_API_URL: "http://localhost:3110",
    AWS_REGION: process.env.AWS_REGION || "us-east-1",
    AWS_ACCESS_KEY_ID: "local-test",
    AWS_SECRET_ACCESS_KEY: "local-test",
  });
  if (process.argv.includes("--check")) {
    console.log(
      "Demo environment targets local services and required values are present.",
    );
    return;
  }
  if (process.argv.includes("--backend")) {
    await backend();
    return;
  }
  await Promise.all([3110, 3180, 3181].map(checkPort));
  const {
    SQSClient,
    CreateQueueCommand,
    GetQueueAttributesCommand,
  } = require("@aws-sdk/client-sqs");
  const { db } = require("../../lib/db");
  const {
    users,
    organization,
    workflows,
    internalServiceHmacSecrets,
  } = require("../../lib/db/schema");
  const { eq, and, inArray } = require("drizzle-orm");
  const {
    encryptSecret,
    decryptSecret,
  } = require("../../lib/agentic-wallet/hmac-secret-store");
  const {
    consumeHermesStream,
  } = require("../../keeperhub-events/event-tracker/src/pyth/hermes-stream");
  const {
    enqueueWorkflowUpstreamTrigger,
  } = require("../../keeperhub-events/event-tracker/lib/workflow-sqs");
  const postgres = require("postgres");
  const sql = postgres(process.env.DATABASE_URL, { max: 1 });
  const sqs = new SQSClient({
    region: process.env.AWS_REGION,
    endpoint: process.env.AWS_ENDPOINT_URL,
  });
  const runId = randomUUID();
  const output = path.join(root, "tmp/pyth-demo", runId);
  fs.mkdirSync(output, { recursive: true, mode: 0o700 });
  const write = (name, value) =>
    fs.writeFileSync(
      path.join(output, name),
      JSON.stringify(value, null, 2) + "\n",
    );
  const children = [];
  const workflowIds = [];
  let stopping = false;
  for (const signal of ["SIGINT", "SIGTERM"])
    process.once(signal, () => {
      stopping = true;
    });
  const start = (args, cwd, name, extraEnv = {}) => {
    const fd = fs.openSync(path.join(output, name), "w", 0o600);
    try {
      const child = spawn(process.execPath, args, {
        cwd,
        env: { ...process.env, ...extraEnv },
        stdio: ["ignore", fd, fd],
      });
      children.push(child);
      return child;
    } finally {
      fs.closeSync(fd);
    }
  };
  const assertRunning = () => {
    if (stopping) throw Error("Demo interrupted");
    if (
      children.some(
        (child) => child.exitCode !== null || child.signalCode !== null,
      )
    )
      throw Error(`Demo process stopped unexpectedly; inspect ${output}`);
  };
  try {
    const queueUrl = process.env.SQS_QUEUE_URL;
    const queueName = new URL(queueUrl).pathname
      .split("/")
      .filter(Boolean)
      .at(-1);
    const created = await sqs.send(
      new CreateQueueCommand({
        QueueName: queueName,
        Attributes: { VisibilityTimeout: "30" },
      }),
      { abortSignal: AbortSignal.timeout(10000) },
    );
    if (created.QueueUrl !== queueUrl)
      throw Error(
        "Queue emulator returned a different URL; check SQS_QUEUE_URL",
      );
    await sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: queueUrl,
        AttributeNames: ["VisibilityTimeout"],
      }),
    );
    const [stored] = await db
      .select()
      .from(internalServiceHmacSecrets)
      .where(
        and(
          eq(internalServiceHmacSecrets.caller, "*shared*"),
          eq(internalServiceHmacSecrets.keyVersion, 1),
        ),
      );
    if (stored) {
      if (
        stored.expiresAt ||
        decryptSecret(stored.secretCiphertext, "*shared*", 1) !==
          process.env.INTERNAL_SERVICE_HMAC_SECRET
      )
        throw Error(
          "Local HMAC database record does not match the configured active secret",
        );
    } else {
      await db.insert(internalServiceHmacSecrets).values({
        caller: "*shared*",
        keyVersion: 1,
        secretCiphertext: encryptSecret(
          process.env.INTERNAL_SERVICE_HMAC_SECRET,
          "*shared*",
          1,
        ),
      });
    }
    const userId = `pyth-demo-${runId}`;
    const organizationId = userId;
    await db.insert(users).values({
      id: userId,
      name: "Pyth backend demo",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(organization).values({
      id: organizationId,
      name: "Pyth backend demo",
      slug: organizationId,
      createdAt: new Date(),
    });
    start(["--import", "tsx", __filename, "--backend"], root, "backend.log", {
      HEALTH_PORT: "3180",
    });
    const readyBy = Date.now() + 60000;
    while (
      !fs
        .readFileSync(path.join(output, "backend.log"), "utf8")
        .includes("Health check server listening")
    ) {
      assertRunning();
      if (Date.now() > readyBy)
        throw Error(`Backend readiness timed out; inspect ${output}`);
      await sleep(500);
    }
    const feedId =
      "ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace";
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    let reference;
    console.log("Sampling a fresh authenticated ETH/USD update...");
    try {
      await consumeHermesStream({
        apiKey: process.env.PYTH_API_KEY,
        feedId,
        signal: controller.signal,
        onPrice: async (update) => {
          if (!reference) reference = update;
          controller.abort();
        },
      });
    } catch (error) {
      if (!reference) throw error;
    } finally {
      clearTimeout(timer);
    }
    if (!reference || reference.price.expo !== -8)
      throw Error("Expected a live ETH/USD update with exponent -8");
    const decimal = (raw) => {
      const value = raw.toString().padStart(9, "0");
      return `${value.slice(0, -8)}.${value.slice(-8)}`;
    };
    const price = BigInt(reference.price.price);
    const configured = [];
    for (const direction of ["above", "below"]) {
      const sign = direction === "above" ? 1n : -1n;
      const config = {
        triggerType: "Pyth Price",
        feedId,
        direction,
        threshold: decimal(price + sign * 100000000n),
        rearmThreshold: decimal(price + sign * 50000000n),
        maxAgeSeconds: 120,
      };
      const id = randomUUID();
      const nodes = [
        {
          id: "pyth",
          type: "trigger",
          position: { x: 250, y: 0 },
          data: { type: "trigger", label: "Pyth", config },
        },
        {
          id: "record-price",
          type: "action",
          position: { x: 250, y: 250 },
          data: {
            type: "action",
            label: "Record observed USD price",
            config: {
              actionType: "math/aggregate",
              operation: "sum",
              inputMode: "explicit",
              explicitValues: "{{@pyth:Pyth.price}}",
              postOperation: "divide",
              postOperand: "100000000",
            },
          },
        },
      ];
      const edges = [
        { id: "pyth-to-record", source: "pyth", target: "record-price" },
      ];
      await db.insert(workflows).values({
        id,
        userId,
        organizationId,
        name: `Pyth demo ${direction}`,
        enabled: true,
        nodes,
        edges,
      });
      workflowIds.push(id);
      configured.push({ id, config });
    }
    write("configuration.json", {
      configuredAt: new Date().toISOString(),
      reference,
      workflows: configured,
    });
    start(
      ["--import", "tsx", "src/index.ts"],
      path.join(root, "keeperhub-events/event-tracker"),
      "worker.log",
      { HEALTH_PORT: "3181" },
    );
    console.log(
      `Reference ETH/USD: ${decimal(price)}. Waiting up to 10 minutes for a live crossing.`,
    );
    console.log(`Logs and evidence: ${output}`);
    const deadline = Date.now() + 600000;
    const seen = new Set();
    let nextProgress = Date.now() + 30000;
    while (Date.now() < deadline) {
      assertRunning();
      const rows =
        await sql`select id,workflow_id,status,input,output,error from workflow_executions where workflow_id in ${sql(workflowIds)} order by started_at`;
      if (Date.now() >= nextProgress) {
        const [checkpoint] =
          await sql`select max(last_publish_time) as published, count(*) filter (where armed)::int as armed from pyth_trigger_checkpoints where workflow_id in ${sql(workflowIds)}`;
        console.log(
          checkpoint.published
            ? `Feed checkpoint: last accepted update ${Math.max(0, Math.floor(Date.now() / 1000) - Number(checkpoint.published))}s ago; ${checkpoint.armed}/2 triggers armed.`
            : "Waiting for the worker to establish the first feed baseline.",
        );
        nextProgress = Date.now() + 30000;
      }
      for (const row of rows) {
        const key = `${row.id}:${row.status}`;
        if (!seen.has(key)) {
          seen.add(key);
          console.log(
            `Execution ${row.id}: ${row.status}${row.status === "phantom" ? " (awaiting queue delivery and executor claim)" : ""}`,
          );
        }
        if (row.status !== "success" || row.output?.success !== true) continue;
        const logs =
          await sql`select node_id,status,input,output,error from workflow_execution_logs where execution_id=${row.id}`;
        const actions = logs.filter(
          (log) =>
            log.node_id === "record-price" &&
            log.status === "success" &&
            log.output?.success === true &&
            !log.error,
        );
        if (
          actions.length !== 1 ||
          row.input.exponent !== -8 ||
          Number(actions[0].output.result) !==
            Number(row.input.price) / 100000000
        )
          throw Error("Action output did not match the live trigger price");
        write("execution.json", {
          verifiedAt: new Date().toISOString(),
          environment:
            "Live Hermes; local production route handlers, Postgres, SQS emulator and in-process executor. No frontend or hosted deployment.",
          execution: row,
          logs,
        });
        console.log(
          `NEW LIVE RUN PASSED: ${row.id} | ETH/USD ${row.output.result}`,
        );
        if (row.input.expiresAt < Date.now() + 15000) {
          throw Error(
            "Live execution passed, but the signal is too close to expiry to verify redelivery. Evidence saved; rerun for the complete check.",
          );
        }
        const trigger = {
          executionId: row.id,
          workflowId: row.workflow_id,
          userId,
          configHash: row.input.configHash,
          triggerData: row.input,
        };
        const sentAt = new Date().toISOString();
        await enqueueWorkflowUpstreamTrigger(sqs, queueUrl, trigger);
        await enqueueWorkflowUpstreamTrigger(sqs, queueUrl, trigger);
        const replayDeadline = Date.now() + 10000;
        let duplicateLines = [];
        while (Date.now() < replayDeadline) {
          assertRunning();
          duplicateLines = fs
            .readFileSync(path.join(output, "backend.log"), "utf8")
            .split("\n")
            .filter(
              (line) =>
                line.includes(row.id) &&
                line.includes("Duplicate upstream delivery (already_advanced)"),
            );
          if (duplicateLines.length >= 2) break;
          await sleep(500);
        }
        const actionCount =
          await sql`select count(*)::int as count from workflow_execution_logs where execution_id=${row.id} and node_id='record-price'`;
        if (duplicateLines.length !== 2 || actionCount[0].count !== 1)
          throw Error(
            "Queue redelivery check did not confirm two rejected deliveries and one action",
          );
        write("redelivery.json", {
          verifiedAt: new Date().toISOString(),
          sentAt,
          expiresAt: row.input.expiresAt,
          executionId: row.id,
          copiesSent: 2,
          actionCount: 1,
          consumerLogs: duplicateLines.map((line) => JSON.parse(line)),
        });
        console.log(
          "REDELIVERY CHECK PASSED: two duplicate deliveries, one action execution.",
        );
        return;
      }
      await sleep(1000);
    }
    throw Error(
      "No successful new crossing within 10 minutes. Rerun to choose thresholds around a fresh price.",
    );
  } finally {
    // Disable only this run's fixtures, leaving its database logs available.
    try {
      if (workflowIds.length)
        await db
          .update(workflows)
          .set({ enabled: false })
          .where(inArray(workflows.id, workflowIds));
    } finally {
      for (const child of children) child.kill("SIGTERM");
      const force = setTimeout(() => {
        for (const child of children)
          if (child.exitCode === null && child.signalCode === null)
            child.kill("SIGKILL");
      }, 10000);
      await Promise.all(
        children.map((child) =>
          child.exitCode !== null || child.signalCode !== null
            ? Promise.resolve()
            : new Promise((resolve) => child.once("exit", resolve)),
        ),
      );
      clearTimeout(force);
      sqs.destroy();
      await sql.end();
      console.log(
        "Demo stopped; its workflows are disabled and evidence is preserved.",
      );
    }
  }
}
main()
  .then(() => {
    if (!process.argv.includes("--backend")) process.exit(0);
  })
  .catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
