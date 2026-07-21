# KeeperHub Starter Template

A minimal, copy-paste project that gets you from zero to your first onchain transaction in under 5 minutes.

## Quick Start

```bash
# 1. Clone this template
git clone https://github.com/ubongn/keeperhub-starter.git
cd keeperhub-starter

# 2. Install dependencies
npm install

# 3. Set your API key
cp .env.example .env
# Edit .env and add your KeeperHub API key (get one at https://app.keeperhub.com/settings)

# 4. Run the starter
npm start
```

## What This Does

1. **Connects** to KeeperHub API
2. **Reads** your wallet balance (USDC via contract-call)
3. **Simulates** a transfer (dry-run, no broadcast)
4. **Executes** a real transfer (if you confirm)
5. **Polls** for the transaction hash
6. **Prints** the explorer link

## Architecture

```
keeperhub-starter/
├── src/
│   └── index.ts        # Main entry point — read → simulate → execute → confirm
├── .env.example        # Template for environment variables
├── package.json        # Dependencies
└── README.md           # This file
```

## Configuration

| Variable | Required | Description |
|----------|----------|-------------|
| `KH_API_KEY` | Yes | Your KeeperHub organization API key (`kh_...`) |
| `KH_NETWORK` | No | Network name or chainId (default: `sepolia`) |
| `KH_RECIPIENT` | No | Recipient address (default: self-transfer) |
| `KH_AMOUNT` | No | Amount to transfer in ETH (default: `0.001`) |

## Supported Chains

| Network | chainId | Testnet |
|---------|---------|---------|
| Ethereum Sepolia | 11155111 | ✅ |
| Base Sepolia | 84532 | ✅ |
| Ethereum | 1 | ❌ |
| Base | 8453 | ❌ |

## Troubleshooting

### "Missing required field" error
- Make sure you're using `functionName` and `functionArgs` (not `abiFunction` and `args`)
- `functionArgs` must be a JSON string: `JSON.stringify([address])`

### "Insufficient ETH balance" error
- Check your wallet balance on Etherscan
- Use `simulate: true` first to validate
- Make sure you're on a testnet with sufficient funds

### "Rate limit" error
- Wait for `Retry-After` seconds
- Use `Idempotency-Key` header for safe retries

## Next Steps

- [KeeperHub Docs](https://docs.keeperhub.com)
- [Direct Execution API](https://docs.keeperhub.com/api/direct-execution)
- [Hackathon Quickstart](https://docs.keeperhub.com/quickstart)
- [KeeperHub GitHub](https://github.com/KeeperHub/keeperhub)

## License

MIT
