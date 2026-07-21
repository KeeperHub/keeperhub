/**
 * KeeperHub Starter — Zero to First Transaction in 5 Minutes
 *
 * This script demonstrates the complete KeeperHub Direct Execution flow:
 *   1. Read wallet balance via contract-call
 *   2. Simulate a transfer (dry-run)
 *   3. Execute the transfer (real broadcast)
 *   4. Poll for confirmation
 *   5. Print the explorer link
 *
 * Run: npm start
 */

import 'dotenv/config';

// ── Configuration ──────────────────────────────────────────────────────────

const KH_API_KEY = process.env.KH_API_KEY || '';
const KH_NETWORK = process.env.KH_NETWORK || 'sepolia';
const KH_RECIPIENT = process.env.KH_RECIPIENT || ''; // empty = self-transfer
const KH_AMOUNT = process.env.KH_AMOUNT || '0.001';
const KH_BASE_URL = process.env.KH_BASE_URL || 'https://app.keeperhub.com';

if (!KH_API_KEY) {
  console.error('❌ Missing KH_API_KEY. Get one at https://app.keeperhub.com/settings');
  process.exit(1);
}

// ── Helpers ────────────────────────────────────────────────────────────────

async function api(method: string, path: string, body?: unknown) {
  const res = await fetch(`${KH_BASE_URL}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${KH_API_KEY}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API ${res.status}: ${text}`);
  }
  return res.json();
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Step 1: Read Balance ───────────────────────────────────────────────────

async function readBalance() {
  console.log('\n📖 Step 1: Reading USDC balance...');

  // Sepolia USDC contract
  const USDC_ADDRESS = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238';
  const WALLET = process.env.KH_WALLET_ADDRESS || '0x0000000000000000000000000000000000000000';

  const ABI = JSON.stringify([
    {
      constant: true,
      inputs: [{ name: 'account', type: 'address' }],
      name: 'balanceOf',
      outputs: [{ name: '', type: 'uint256' }],
      type: 'function',
    },
  ]);

  try {
    const result = await api('POST', '/api/execute/contract-call', {
      chainId: KH_NETWORK === 'sepolia' ? 11155111 : 84532,
      contractAddress: USDC_ADDRESS,
      functionName: 'balanceOf',
      functionArgs: JSON.stringify([WALLET]),
      abi: ABI,
      simulate: true,
    });

    console.log('   ✅ Balance read:', result.result || '0');
    return result;
  } catch (e) {
    console.log('   ⚠️  Balance read failed (expected if no USDC):', (e as Error).message);
    return null;
  }
}

// ── Step 2: Simulate Transfer ──────────────────────────────────────────────

async function simulateTransfer() {
  console.log('\n🔍 Step 2: Simulating transfer (dry-run)...');

  const recipient = KH_RECIPIENT || process.env.KH_WALLET_ADDRESS || '0x0000000000000000000000000000000000000000';

  try {
    const result = await api('POST', '/api/execute/transfer', {
      chainId: KH_NETWORK === 'sepolia' ? 11155111 : 84532,
      recipientAddress: recipient,
      amount: KH_AMOUNT,
      simulate: true,
    });

    console.log('   ✅ Simulation result:', result);
    return result;
  } catch (e) {
    console.log('   ❌ Simulation failed:', (e as Error).message);
    throw e;
  }
}

// ── Step 3: Execute Transfer ───────────────────────────────────────────────

async function executeTransfer() {
  console.log('\n🚀 Step 3: Executing real transfer...');

  const recipient = KH_RECIPIENT || process.env.KH_WALLET_ADDRESS || '0x0000000000000000000000000000000000000000';
  const idempotencyKey = crypto.randomUUID();

  try {
    const result = await api('POST', '/api/execute/transfer', {
      chainId: KH_NETWORK === 'sepolia' ? 11155111 : 84532,
      recipientAddress: recipient,
      amount: KH_AMOUNT,
    });

    console.log('   ✅ Execution started:', result.executionId);
    return result.executionId;
  } catch (e) {
    console.log('   ❌ Execution failed:', (e as Error).message);
    throw e;
  }
}

// ── Step 4: Poll for Confirmation ──────────────────────────────────────────

async function waitForConfirmation(executionId: string) {
  console.log('\n⏳ Step 4: Polling for confirmation...');

  const deadline = Date.now() + 60_000; // 60s timeout

  while (Date.now() < deadline) {
    try {
      const status = await api('GET', `/api/execute/${executionId}/status`);
      console.log(`   📊 Status: ${status.status}`);

      if (status.status === 'completed') {
        console.log('   ✅ Transaction confirmed!');
        return status;
      }

      if (status.status === 'failed') {
        console.log('   ❌ Transaction failed:', status.error);
        return status;
      }

      // Wait before next poll
      await sleep(2000);
    } catch (e) {
      console.log('   ⚠️  Poll error, retrying:', (e as Error).message);
      await sleep(2000);
    }
  }

  console.log('   ⏰ Timeout waiting for confirmation');
  return null;
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log('🛡️  KeeperHub Starter — Zero to First Transaction');
  console.log('================================================');
  console.log(`   Network: ${KH_NETWORK}`);
  console.log(`   Amount:  ${KH_AMOUNT} ETH`);
  console.log(`   API Key: ${KH_API_KEY.slice(0, 10)}...`);

  // Step 1: Read balance
  await readBalance();

  // Step 2: Simulate
  const simulation = await simulateTransfer();

  // Step 3: Ask for confirmation
  console.log('\n❓ Ready to execute? (simulated successfully)');
  console.log('   Press Ctrl+C to abort, or wait 3 seconds to continue...');
  await sleep(3000);

  // Step 4: Execute
  const executionId = await executeTransfer();

  // Step 5: Wait for confirmation
  const result = await waitForConfirmation(executionId);

  // Step 6: Print explorer link
  if (result?.transactionLink) {
    console.log('\n🎉 Success!');
    console.log(`   Transaction: ${result.transactionHash}`);
    console.log(`   Explorer:    ${result.transactionLink}`);
    console.log(`   Gas Used:    ${result.gasUsedWei || 'N/A'}`);
  } else {
    console.log('\n⚠️  Transaction pending or failed. Check status manually.');
    console.log(`   Execution ID: ${executionId}`);
    console.log(`   Status URL:   ${KH_BASE_URL}/api/execute/${executionId}/status`);
  }
}

main().catch((e) => {
  console.error('\n💥 Fatal error:', e);
  process.exit(1);
});
