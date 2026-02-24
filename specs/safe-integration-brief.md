Safe Events Service Integration

We've confirmed Safe runs a hosted Events Service at safe-events.safe.global with a per-address SSE endpoint at /events/sse/{SAFE_ADDRESS}. This would give us near real-time notifications for pending multisig transactions instead of polling every 5 minutes.

The endpoint exists and responds but returns 403 Forbidden -- it requires an SSE_AUTH_TOKEN that Safe controls. There is no self-service registration. The webhook registration path has the same dependency -- webhook destinations are managed through their internal admin panel.

We'd like to explore a partnership/integration with Safe to get access to the SSE endpoint. What we need from them:

- An SSE_AUTH_TOKEN for safe-events.safe.global (Basic auth)
- Confirmation on connection limits (how many concurrent SSE connections per token)
- Confirmation on supported chains (likely matches their Transaction Service coverage)

What we offer them:

- KeeperHub becomes a distribution channel for Safe -- users set up monitoring workflows through our platform
- We handle all the downstream logic (tx analysis, risk assessment, notifications) so Safe doesn't have to build that
- We drive usage of their Transaction Service API (we already call it for full tx details)

We have a working polling-based workflow live now (Safe Signing Alert) so there's no urgency. The SSE integration is a latency improvement from ~5 minutes to ~15 seconds.
