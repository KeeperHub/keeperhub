# UAT v4: Production Hardening

## Version Scope

v4 builds on all v1, v2, and v3 test cases. This version focuses on production readiness: external session storage backed by Redis/Upstash, SSE resumability with `Last-Event-ID`, per-session and per-org rate limiting, structured logging and metrics, security hardening (DNS rebinding protection, CORS), load testing under concurrent sessions, and graceful degradation when backing services are unavailable.

**Prerequisites**: All v1 test cases (TC-01 through TC-54), v2 test cases (TC-55 through TC-95), and v3 test cases (TC-96 through TC-139) pass before running v4 tests.

---

## 1. External Session Store

- [ ] **TC-140: Sessions persist across pod restarts**
  - Precondition: Active MCP session, Redis/Upstash backing store configured
  - Steps: Initialize a session and call `tools/list` to confirm it works. Restart the application pod (e.g., `kubectl rollout restart`). Send `tools/list` with the same `Mcp-Session-Id`.
  - Expected: Request succeeds. Session data survived the restart.

- [ ] **TC-141: Session data stored in Redis**
  - Precondition: Active session
  - Steps: Inspect Redis keys (e.g., `redis-cli keys "mcp:session:*"`)
  - Expected: Session key exists in Redis containing session metadata (org ID, auth info, creation time)

- [ ] **TC-142: Session TTL set in Redis**
  - Precondition: Active session
  - Steps: Check TTL on the session key in Redis (`redis-cli ttl "mcp:session:<id>"`)
  - Expected: TTL is approximately 1800 seconds (30 minutes) or matches the configured session timeout

- [ ] **TC-143: Session TTL refreshed on activity**
  - Precondition: Active session with known TTL
  - Steps: Wait 10 minutes, then send a `tools/list` request. Check the TTL again.
  - Expected: TTL reset to the full timeout duration (30 minutes), not the remaining time from before

- [ ] **TC-144: Session DELETE removes from Redis**
  - Precondition: Active session
  - Steps: Send `DELETE /mcp` with session ID. Check Redis for the key.
  - Expected: Key no longer exists in Redis

- [ ] **TC-145: Multiple pods share session state**
  - Precondition: Multiple application pods behind a load balancer, shared Redis
  - Steps: Initialize a session hitting Pod A. Send subsequent requests that hit Pod B (different pod).
  - Expected: All requests succeed. Session state is consistent regardless of which pod handles the request.

---

## 2. Resumability

- [ ] **TC-146: SSE events include unique IDs**
  - Precondition: SSE connection established, events flowing
  - Steps: Inspect the raw SSE stream
  - Expected: Each event has an `id:` field with a unique, monotonically increasing identifier

- [ ] **TC-147: Client reconnects with Last-Event-ID**
  - Precondition: SSE connection that received events with IDs, then disconnected
  - Steps: Reconnect `GET /mcp` with `Last-Event-ID: <last-received-id>` header
  - Expected: HTTP 200. Server resumes from after the specified event ID.

- [ ] **TC-148: Missed events replayed on reconnect**
  - Precondition: SSE connection dropped during active workflow execution
  - Steps: Reconnect with `Last-Event-ID` set to the last event received before disconnect
  - Expected: All events that occurred between the disconnect and reconnect are replayed in order before new events stream

- [ ] **TC-149: Very old Last-Event-ID handled gracefully**
  - Precondition: Event buffer has a limited retention window
  - Steps: Reconnect with a `Last-Event-ID` from hours ago (beyond the buffer)
  - Expected: Server either replays from the oldest available event (with indication of gap) or returns an error asking client to re-initialize. No crash or hang.

- [ ] **TC-150: Reconnect without Last-Event-ID starts fresh**
  - Precondition: Previous SSE connection received events
  - Steps: Reconnect `GET /mcp` without `Last-Event-ID` header
  - Expected: No event replay. Stream starts with new events only.

- [ ] **TC-151: Event buffer persists in Redis**
  - Precondition: Events generated during a session
  - Steps: Restart the application pod. Reconnect SSE with `Last-Event-ID`.
  - Expected: Events from before the restart are replayed. Buffer survives pod restart.

---

## 3. Rate Limiting

- [ ] **TC-152: Per-session rate limit enforced**
  - Precondition: Active session, known per-session limit (e.g., 60 requests/minute)
  - Steps: Send requests at the rate limit + 1 within the window
  - Expected: Requests within the limit succeed. The request exceeding the limit receives HTTP 429.

- [ ] **TC-153: Per-org rate limit enforced**
  - Precondition: Two active sessions for the same org, known per-org limit
  - Steps: Split requests across both sessions to collectively exceed the per-org limit
  - Expected: Once the org limit is hit, both sessions receive HTTP 429 until the window resets

- [ ] **TC-154: 429 response includes Retry-After header**
  - Precondition: Rate limit triggered
  - Steps: Inspect the 429 response headers
  - Expected: `Retry-After` header present with a value in seconds indicating when to retry

- [ ] **TC-155: 429 response body is valid JSON-RPC error**
  - Precondition: Rate limit triggered
  - Steps: Inspect the 429 response body
  - Expected: Valid JSON-RPC error object with an appropriate error code and message indicating rate limit exceeded

- [ ] **TC-156: Rate limit resets after window expires**
  - Precondition: Rate limit triggered, Retry-After value known
  - Steps: Wait for the Retry-After duration, then send another request
  - Expected: Request succeeds. Rate limit counter has reset.

- [ ] **TC-157: Read operations and write operations have separate limits**
  - Precondition: Active session
  - Steps: Exhaust the rate limit with `tools/list` (read) calls. Then call `workflow_create` (write).
  - Expected: If separate limits exist, write still works when read limit is exhausted (and vice versa). If unified, both are blocked. Behavior should match documentation.

- [ ] **TC-158: Rate limit state stored externally (survives pod restart)**
  - Precondition: Rate limit partially consumed, Redis backing
  - Steps: Consume half the rate limit. Restart the pod. Send more requests up to the original limit.
  - Expected: The pre-restart consumption is counted. Total across restart equals the limit.

---

## 4. Monitoring

- [ ] **TC-159: Structured logs emitted for session lifecycle**
  - Precondition: Application logging configured (JSON structured logs)
  - Steps: Initialize a session, call tools, terminate session. Inspect application logs.
  - Expected: Logs contain entries for session_created, tool_call, session_terminated. Each entry has structured fields: timestamp, session_id, org_id, event_type, and relevant metadata.

- [ ] **TC-160: Structured logs for tool calls include timing**
  - Precondition: Active session
  - Steps: Call a tool (e.g., `workflow_list`). Inspect logs.
  - Expected: Log entry includes `tool_name`, `duration_ms`, `status` (success/error), and `org_id`

- [ ] **TC-161: Structured logs for errors include context**
  - Precondition: Active session
  - Steps: Call a tool with invalid params to trigger an error. Inspect logs.
  - Expected: Log entry includes `error_code`, `error_message`, `tool_name`, `session_id`, and request metadata

- [ ] **TC-162: Metrics tracked for session count**
  - Precondition: Metrics endpoint or monitoring dashboard accessible
  - Steps: Initialize 3 sessions. Check metrics.
  - Expected: Active session count metric reflects 3. After terminating one, it reflects 2.

- [ ] **TC-163: Metrics tracked for tool call latency**
  - Precondition: Metrics collection active
  - Steps: Call multiple tools. Check metrics.
  - Expected: Tool call latency histogram/percentiles available, broken down by tool name

- [ ] **TC-164: Metrics tracked for error rates**
  - Precondition: Metrics collection active
  - Steps: Generate some successful and some failed tool calls. Check metrics.
  - Expected: Error rate metric available, broken down by error type (auth failure, validation error, server error)

- [ ] **TC-165: Auth failure logs do not leak credentials**
  - Precondition: Logging active
  - Steps: Send requests with invalid API keys and invalid OAuth tokens. Inspect logs.
  - Expected: Logs contain the auth failure event but do NOT contain the full API key or token value. At most a truncated/masked version.

---

## 5. Security

- [ ] **TC-166: DNS rebinding protection via allowedHosts**
  - Precondition: Server configured with `allowedHosts: ["app.keeperhub.com"]`
  - Steps: Send request with `Host: evil.com` header
  - Expected: HTTP 403 or connection refused. Request not processed.

- [ ] **TC-167: Origin validation via allowedOrigins**
  - Precondition: Server configured with allowed origins
  - Steps: Send request with `Origin: https://evil.com`
  - Expected: Request rejected or CORS headers not set for that origin

- [ ] **TC-168: CORS preflight returns correct headers**
  - Precondition: None
  - Steps: Send `OPTIONS /mcp` with `Origin: https://app.keeperhub.com`, `Access-Control-Request-Method: POST`, `Access-Control-Request-Headers: Authorization, Content-Type, Mcp-Session-Id`
  - Expected: Response includes `Access-Control-Allow-Origin`, `Access-Control-Allow-Methods` (includes POST, GET, DELETE), `Access-Control-Allow-Headers` (includes Authorization, Content-Type, Mcp-Session-Id), `Access-Control-Expose-Headers` (includes Mcp-Session-Id)

- [ ] **TC-169: CORS headers on actual requests**
  - Precondition: None
  - Steps: Send `POST /mcp` with valid `Origin` header
  - Expected: Response includes `Access-Control-Allow-Origin` and `Access-Control-Expose-Headers: Mcp-Session-Id`

- [ ] **TC-170: No sensitive headers exposed in CORS**
  - Precondition: None
  - Steps: Inspect `Access-Control-Expose-Headers`
  - Expected: Only necessary headers exposed (e.g., `Mcp-Session-Id`). No internal headers leaked.

- [ ] **TC-171: Request body size limit enforced**
  - Precondition: Active session
  - Steps: Send a `POST /mcp` with a body exceeding the size limit (e.g., 10MB of JSON)
  - Expected: HTTP 413 Payload Too Large. Request not processed.

- [ ] **TC-172: Session fixation not possible**
  - Precondition: None
  - Steps: Send `initialize` with a fabricated `Mcp-Session-Id` header
  - Expected: Server ignores the client-provided session ID on initialize and generates its own. The response `Mcp-Session-Id` is server-generated.

- [ ] **TC-173: Timing-safe token comparison**
  - Precondition: None
  - Steps: Send multiple requests with tokens that differ by one character at different positions. Measure response times.
  - Expected: No statistically significant timing difference based on which character is wrong. Prevents timing attacks.

---

## 6. Load Testing

- [ ] **TC-174: Concurrent session creation**
  - Precondition: Load testing tool (e.g., k6, Artillery)
  - Steps: Send 100 concurrent `initialize` requests, each with a valid API key
  - Expected: All 100 succeed (or up to the session limit). No 500 errors. Response times under 2 seconds at p95.

- [ ] **TC-175: High-frequency tool calls on single session**
  - Precondition: Active session
  - Steps: Send 50 `tools/call` requests per second for 60 seconds (3000 total) for `workflow_list`
  - Expected: Requests within rate limits succeed. Rate-limited requests get 429 with Retry-After. No 500 errors. No session corruption.

- [ ] **TC-176: Concurrent tool calls across multiple sessions**
  - Precondition: 20 active sessions
  - Steps: Each session sends 5 tool calls per second for 60 seconds (6000 total across all sessions)
  - Expected: All within-limit requests succeed. Responses are correct (no cross-session data leaks). p95 latency under 5 seconds.

- [ ] **TC-177: Session cleanup under load**
  - Precondition: 50 active sessions, steady tool call traffic
  - Steps: Let 25 sessions expire (no requests for 30 min). Continue traffic on remaining 25.
  - Expected: Expired sessions cleaned up. Active sessions unaffected. Redis key count decreases. No memory leaks.

- [ ] **TC-178: SSE connections under load**
  - Precondition: 50 concurrent SSE connections
  - Steps: Trigger workflow executions that generate events. Monitor all SSE streams.
  - Expected: All SSE connections receive their events. No dropped events. Server memory stable.

- [ ] **TC-179: Spike test (sudden burst)**
  - Precondition: Baseline of 10 requests/second
  - Steps: Spike to 500 requests/second for 10 seconds, then return to baseline
  - Expected: During spike, rate limits applied. After spike, service recovers to normal latency within 30 seconds. No cascading failures.

- [ ] **TC-180: Long-running session stability**
  - Precondition: Active session
  - Steps: Keep a session alive for 4 hours with periodic tool calls (one per minute)
  - Expected: Session remains valid for the entire duration (TTL refreshed on each call). No degradation in response time.

---

## 7. Graceful Degradation

- [ ] **TC-181: Redis down falls back to in-memory sessions**
  - Precondition: Redis/Upstash connection configured
  - Steps: Simulate Redis outage (disconnect or block port). Initialize a new session.
  - Expected: Session created using in-memory fallback. Tools work normally. Log entry warns about Redis unavailability.

- [ ] **TC-182: Existing sessions degrade gracefully when Redis goes down**
  - Precondition: Active session stored in Redis
  - Steps: Simulate Redis outage. Send `tools/list` with the existing session.
  - Expected: Either the session is recreated in-memory (with possible re-auth), or a clear error instructs the client to re-initialize. No 500 crash.

- [ ] **TC-183: Redis recovery restores normal operation**
  - Precondition: Redis was down, in-memory fallback active
  - Steps: Restore Redis. Initialize a new session. Verify it is stored in Redis.
  - Expected: New sessions go to Redis. Transition is seamless. No manual intervention needed.

- [ ] **TC-184: Upstream API errors return clean JSON-RPC errors**
  - Precondition: Active session
  - Steps: Call a tool that depends on an external API (e.g., `web3_check-balance` when RPC node is down)
  - Expected: JSON-RPC error response with a meaningful message (e.g., "Upstream RPC unavailable"). No raw stack traces or internal error details exposed.

- [ ] **TC-185: Database unavailable returns clean error**
  - Precondition: Active session
  - Steps: Simulate database outage. Call `workflow_list`.
  - Expected: JSON-RPC error with message indicating temporary unavailability. HTTP status 503 or JSON-RPC internal error code.

- [ ] **TC-186: Partial tool availability**
  - Precondition: Active session, one external dependency down (e.g., blockchain RPC)
  - Steps: Call a tool that does not depend on the down service (e.g., `workflow_list`). Then call one that does (e.g., `web3_check-balance`).
  - Expected: `workflow_list` succeeds. `web3_check-balance` returns a clean error. One failure does not affect other tools.

- [ ] **TC-187: Health check endpoint reflects degraded state**
  - Precondition: Redis down or database down
  - Steps: Call the health check endpoint (e.g., `GET /api/health` or similar)
  - Expected: Returns degraded status with details of which backing services are unavailable. Does not return "healthy" when dependencies are down.

- [ ] **TC-188: In-memory session limit enforced during fallback**
  - Precondition: Redis down, in-memory fallback active
  - Steps: Create sessions up to a reasonable in-memory limit (e.g., 1000)
  - Expected: Limit enforced to prevent memory exhaustion. Clear error when limit reached.

- [ ] **TC-189: Event buffer fallback when Redis is down**
  - Precondition: Redis down, SSE events being generated
  - Steps: Generate events during Redis outage. Client reconnects with `Last-Event-ID`.
  - Expected: Events buffered in-memory (limited window). Replay works within the in-memory buffer. Events beyond the buffer return an appropriate error on reconnect.

- [ ] **TC-190: No data loss on graceful shutdown**
  - Precondition: Active sessions with pending operations
  - Steps: Send SIGTERM to the application process during active tool calls
  - Expected: In-flight requests complete (or return clean errors). Sessions are persisted to Redis before shutdown. SSE connections closed with appropriate close event.
