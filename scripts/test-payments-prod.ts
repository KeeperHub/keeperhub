/**
 * UAT script for dual-protocol (x402 + MPP) payment-gated workflows.
 *
 * Tests the dual-402 response and both payment flows from a single script.
 *
 * Prerequisites:
 *   - A wallet private key (same key works for both protocols)
 *   - Base USDC for x402 tests, Tempo USDC.e for MPP tests
 *
 * Usage:
 *   PRIVATE_KEY=0x... tsx scripts/test-payments-prod.ts
 *   PRIVATE_KEY=0x... tsx scripts/test-payments-prod.ts --host https://app-staging.keeperhub.com
 *   PRIVATE_KEY=0x... tsx scripts/test-payments-prod.ts --only x402
 *   PRIVATE_KEY=0x... tsx scripts/test-payments-prod.ts --only mpp
 */

import type { PaymentRequired } from "@x402/core/types";
import { x402Client } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { Mppx, tempo } from "mppx/client";
import { privateKeyToAccount } from "viem/accounts";

const BASE_USDC_DECIMALS = 6;

const SLUG = "mcp-test";
const TEST_INPUT = { address: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045" };

const host = process.argv.includes("--host")
  ? process.argv[process.argv.indexOf("--host") + 1]
  : "https://app.keeperhub.com";

const onlyFilter = process.argv.includes("--only")
  ? process.argv[process.argv.indexOf("--only") + 1]
  : null;

const privateKey =
  process.env.PRIVATE_KEY ??
  process.env.X402_TEST_PRIVATE_KEY ??
  process.env.MPP_TEST_PRIVATE_KEY;
if (!privateKey) {
  console.error("Set PRIVATE_KEY (or X402_TEST_PRIVATE_KEY / MPP_TEST_PRIVATE_KEY)");
  process.exit(1);
}

const account = privateKeyToAccount(privateKey as `0x${string}`);

const x402 = new x402Client();
registerExactEvmScheme(x402, { signer: account });

const mpp = Mppx.create({
  methods: [tempo({ account })],
  polyfill: false,
});

console.log(`Host:   ${host}`);
console.log(`Wallet: ${account.address}`);
console.log(`Slug:   ${SLUG}`);
if (onlyFilter) console.log(`Filter: --only ${onlyFilter}`);
console.log();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type TestResult = { pass: boolean; detail: string };

async function test(
  name: string,
  fn: () => Promise<TestResult>
): Promise<boolean> {
  process.stdout.write(`  ${name} ... `);
  try {
    const result = await fn();
    console.log(result.pass ? `PASS  ${result.detail}` : `FAIL  ${result.detail}`);
    return result.pass;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`ERROR  ${msg}`);
    return false;
  }
}

const callUrl = `${host}/api/mcp/workflows/${SLUG}/call`;

function fetch402(): Promise<Response> {
  return fetch(callUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(TEST_INPUT),
  });
}

/**
 * Parses the canonical `PAYMENT-REQUIRED` header (base64-encoded JSON of a
 * `PaymentRequired` from `@x402/core/types`). Falls back to the legacy
 * `X-PAYMENT-REQUIREMENTS` header for transitional compatibility -- both
 * carry the same payload after the discovery-fix release.
 */
function parsePaymentRequiredHeader(res: Response): PaymentRequired | null {
  const header =
    res.headers.get("PAYMENT-REQUIRED") ??
    res.headers.get("X-PAYMENT-REQUIREMENTS");
  if (!header) {
    return null;
  }
  return JSON.parse(
    Buffer.from(header, "base64").toString("utf-8")
  ) as PaymentRequired;
}

// ---------------------------------------------------------------------------
// Shared tests
// ---------------------------------------------------------------------------

async function testDiscovery(): Promise<TestResult> {
  const res = await fetch(`${host}/api/mcp/workflows?q=mcp-test`);
  if (!res.ok) return { pass: false, detail: `HTTP ${res.status}` };
  const data = (await res.json()) as {
    items: { listedSlug: string; priceUsdcPerCall: string }[];
  };
  const found = data.items?.find((w) => w.listedSlug === SLUG);
  if (!found) {
    return { pass: false, detail: `slug "${SLUG}" not in response (${data.items?.length ?? 0} items)` };
  }
  return { pass: true, detail: `price=$${found.priceUsdcPerCall} USDC` };
}

async function testDual402(): Promise<TestResult> {
  const res = await fetch402();
  if (res.status !== 402) {
    return { pass: false, detail: `expected 402, got ${res.status}` };
  }

  const mppHeader = res.headers.get("WWW-Authenticate");

  let parsed: PaymentRequired | null;
  try {
    parsed = parsePaymentRequiredHeader(res);
  } catch {
    return { pass: false, detail: "PAYMENT-REQUIRED not valid base64 JSON" };
  }
  if (!parsed) {
    return { pass: false, detail: "missing PAYMENT-REQUIRED header" };
  }
  const accept = parsed.accepts?.[0];
  const hasAccepts = Boolean(accept?.scheme && accept?.payTo);
  return {
    pass: hasAccepts,
    detail: [
      `x402: v${parsed.x402Version} scheme=${accept?.scheme} payTo=${accept?.payTo?.slice(0, 10)}...`,
      `MPP WWW-Authenticate: ${mppHeader ? "present" : "absent"}`,
    ].join(" | "),
  };
}

async function testInputValidation(): Promise<TestResult> {
  const res = await fetch(`${host}/api/mcp/workflows/${SLUG}/call`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  if (res.status === 400) {
    const data = (await res.json()) as { error?: string };
    return { pass: true, detail: `rejected: ${data.error}` };
  }
  if (res.status === 402) {
    return { pass: true, detail: "402 (payment gate fires before input validation)" };
  }
  return { pass: false, detail: `expected 400 or 402, got ${res.status}` };
}

async function testUnknownSlug(): Promise<TestResult> {
  const res = await fetch(`${host}/api/mcp/workflows/nonexistent-slug-xyz/call`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  if (res.status !== 404) {
    return { pass: false, detail: `expected 404, got ${res.status}` };
  }
  return { pass: true, detail: "404" };
}

// ---------------------------------------------------------------------------
// x402 payment tests (Base USDC)
// ---------------------------------------------------------------------------

let x402ExecutionId = "";
let x402PaymentSig = "";

async function testX402PaidCall(): Promise<TestResult> {
  const initialRes = await fetch402();
  if (initialRes.status !== 402) {
    return { pass: false, detail: `expected 402, got ${initialRes.status}` };
  }

  const paymentRequired = parsePaymentRequiredHeader(initialRes);
  if (!paymentRequired) {
    return { pass: false, detail: "no PAYMENT-REQUIRED header" };
  }
  const firstAccept = paymentRequired.accepts[0];
  const amountUsdc = Number(firstAccept.amount) / 10 ** BASE_USDC_DECIMALS;
  console.log(`\n    x402: $${amountUsdc.toFixed(2)} USDC on ${firstAccept.network} to ${firstAccept.payTo}`);

  const paymentPayload = await x402.createPaymentPayload(paymentRequired);
  const encoded = Buffer.from(JSON.stringify(paymentPayload)).toString("base64");
  x402PaymentSig = encoded;

  const paidRes = await fetch(callUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", "PAYMENT-SIGNATURE": encoded },
    body: JSON.stringify(TEST_INPUT),
  });

  if (!paidRes.ok) {
    const body = await paidRes.text();
    return { pass: false, detail: `${paidRes.status}: ${body.slice(0, 200)}` };
  }

  const data = (await paidRes.json()) as { executionId?: string; status?: string };
  if (!data.executionId) {
    return { pass: false, detail: `no executionId: ${JSON.stringify(data)}` };
  }
  x402ExecutionId = data.executionId;
  return { pass: true, detail: `executionId=${data.executionId}, status=${data.status}` };
}

async function testX402Idempotency(): Promise<TestResult> {
  if (!x402PaymentSig) {
    return { pass: false, detail: "skipped (no payment sig)" };
  }
  const res = await fetch(callUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", "PAYMENT-SIGNATURE": x402PaymentSig },
    body: JSON.stringify(TEST_INPUT),
  });
  if (!res.ok) return { pass: false, detail: `HTTP ${res.status}` };
  const data = (await res.json()) as { executionId?: string };
  if (data.executionId !== x402ExecutionId) {
    return { pass: false, detail: `got ${data.executionId}, expected ${x402ExecutionId}` };
  }
  return { pass: true, detail: `same executionId=${data.executionId}` };
}

// ---------------------------------------------------------------------------
// MPP payment tests (Tempo USDC.e)
// ---------------------------------------------------------------------------

let mppExecutionId = "";
let mppCredential = "";

async function testMppPaidCall(): Promise<TestResult> {
  const initialRes = await fetch402();
  if (initialRes.status !== 402) {
    return { pass: false, detail: `expected 402, got ${initialRes.status}` };
  }

  const wwwAuth = initialRes.headers.get("WWW-Authenticate");
  if (!wwwAuth) {
    return { pass: false, detail: "no WWW-Authenticate header" };
  }

  const credential = await mpp.createCredential(initialRes);
  mppCredential = credential;

  const paidRes = await fetch(callUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: credential },
    body: JSON.stringify(TEST_INPUT),
  });

  if (!paidRes.ok) {
    const body = await paidRes.text();
    return { pass: false, detail: `${paidRes.status}: ${body.slice(0, 200)}` };
  }

  const data = (await paidRes.json()) as { executionId?: string; status?: string };
  if (!data.executionId) {
    return { pass: false, detail: `no executionId: ${JSON.stringify(data)}` };
  }
  mppExecutionId = data.executionId;

  const receipt = paidRes.headers.get("Payment-Receipt");
  const receiptSnip = receipt
    ? `receipt=${receipt.slice(0, 40)}...`
    : "no receipt";
  return { pass: true, detail: `executionId=${data.executionId}, status=${data.status}, ${receiptSnip}` };
}

async function testMppIdempotency(): Promise<TestResult> {
  if (!mppCredential) {
    return { pass: false, detail: "skipped (no credential)" };
  }
  const res = await fetch(callUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: mppCredential },
    body: JSON.stringify(TEST_INPUT),
  });
  if (!res.ok) return { pass: false, detail: `HTTP ${res.status}` };
  const data = (await res.json()) as { executionId?: string };
  if (data.executionId !== mppExecutionId) {
    return { pass: false, detail: `got ${data.executionId}, expected ${mppExecutionId}` };
  }
  return { pass: true, detail: `same executionId=${data.executionId}` };
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("Dual-Protocol Payment UAT\n");

  const runX402 = !onlyFilter || onlyFilter === "x402";
  const runMpp = !onlyFilter || onlyFilter === "mpp";

  const tests: Array<[string, () => Promise<TestResult>]> = [
    ["Discovery: listed workflow", testDiscovery],
    ["Dual 402: x402 + MPP headers", testDual402],
  ];

  if (runX402) {
    tests.push(
      ["x402 paid call (Base USDC)", testX402PaidCall],
      ["x402 idempotency", testX402Idempotency],
    );
  }

  if (runMpp) {
    tests.push(
      ["MPP paid call (Tempo USDC.e)", testMppPaidCall],
      ["MPP idempotency", testMppIdempotency],
    );
  }

  tests.push(
    ["Input validation: missing field", testInputValidation],
    ["Unknown slug: 404", testUnknownSlug],
  );

  let passed = 0;
  let total = 0;
  for (const [name, fn] of tests) {
    total++;
    if (await test(name, fn)) passed++;
  }

  console.log(`\n${passed}/${total} passed`);

  const ids = [
    x402ExecutionId ? `x402: ${x402ExecutionId}` : null,
    mppExecutionId ? `mpp: ${mppExecutionId}` : null,
  ].filter(Boolean);
  if (ids.length > 0) {
    console.log(`\nExecution IDs: ${ids.join(", ")}`);
  }

  process.exit(passed === total ? 0 : 1);
}

main();
