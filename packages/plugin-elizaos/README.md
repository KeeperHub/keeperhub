# @keeperhub/plugin-elizaos

> Official KeeperHub Deterministic Execution & Risk Sentinel Plugin for [ElizaOS](https://github.com/elizaos/eliza).

## 🎯 Overview

AI agents are probabilistic by design. When handling financial transfers, an agent hallucinating parameters or repeating transactions causes catastrophic loss.

`@keeperhub/plugin-elizaos` connects ElizaOS agents directly to KeeperHub's enterprise execution layer, providing:
1. **Zero-Gas Preflight Simulation**: Every contract call or token transfer is simulated (`simulate: true`) before touching the chain.
2. **Idempotency Safeguard**: Guarantees transactions are never executed twice if the agent retries.
3. **Turnkey Non-Custodial Security**: No private keys stored in the agent runtime.
4. **MEV & Gas Protection**: Private routing and automated nonce management.

## 🚀 Installation

```bash
pnpm add @keeperhub/plugin-elizaos
```

## ⚙️ Configuration

Add your KeeperHub Organization API key to your `.env`:

```env
KEEPERHUB_API_KEY=kh_your_org_api_key
KEEPERHUB_MCP_URL=https://app.keeperhub.com/mcp
```

Register the plugin in your ElizaOS character configuration:

```typescript
import { keeperHubPlugin } from '@keeperhub/plugin-elizaos';

export default {
  name: 'DeFiSentinel',
  plugins: [keeperHubPlugin],
  // ...
};
```

## 🧪 Testing

```bash
pnpm test
```
