---
title: "Code Plugin"
description: "Execute custom JavaScript for data transformation, aggregation, and analysis within workflows."
---

# Code Plugin

Execute custom JavaScript in a sandboxed environment. No credentials required -- reference upstream node data directly in your code using template variables.

## Actions

| Action   | Description                                                   |
| -------- | ------------------------------------------------------------- |
| Run Code | Execute JavaScript with access to workflow data via templates |

## Run Code

Execute user-written JavaScript in a `node:vm` sandbox. The code runs in an async context, so `return` and `await` are available at the top level.

Template variables like `{{NodeName.field}}` are resolved by the workflow engine before execution -- the code receives the actual values inline. Type `@` in the editor to autocomplete available upstream node outputs.

### Inputs

| Field     | Type   | Required | Default | Description                       |
| --------- | ------ | -------- | ------- | --------------------------------- |
| `code`    | string | yes      | --      | JavaScript code to execute        |
| `timeout` | number | no       | 60      | Execution timeout in seconds (1-120) |

### Outputs

| Field     | Type    | Description                                              |
| --------- | ------- | -------------------------------------------------------- |
| `success` | boolean | Whether the code executed successfully                   |
| `result`  | any     | The return value of the executed code                    |
| `logs`    | array   | Captured `console.log`, `console.warn`, `console.error` calls |
| `error`   | string  | Error message if execution failed                        |
| `line`    | number  | Line number where the error occurred (if available)      |

### How Template Variables Work in Code

Template variables are resolved **before** execution. The engine uses `processCodeTemplates` which JSON-stringifies values so they are valid JavaScript when inlined:

- **Strings** become quoted: `{{Manual.name}}` -> `"Alice"`
- **Numbers** stay as-is: `{{Manual.count}}` -> `42`
- **Objects/arrays** become JSON: `{{Query.rows}}` -> `[{"id":1},{"id":2}]`
- **null/undefined** become: `null`

This means you write code as if the values are already there:

```javascript
// If Query Events returns { events: [...] }, this becomes valid JS:
const events = {{QueryEvents.events}};
// Resolves to: const events = [{"from":"0x...","value":100}, ...];
```

### Available Globals

- **I/O:** `console`, `fetch`
- **Core types:** `BigInt`, `JSON`, `Math`, `Date`, `Array`, `Object`, `String`, `Number`, `Boolean`, `RegExp`, `Symbol`, `Map`, `Set`, `WeakMap`, `WeakSet`, `Promise`
- **Error types:** `Error`, `TypeError`, `RangeError`, `SyntaxError`, `ReferenceError`, `URIError`
- **Numeric/parsing:** `parseInt`, `parseFloat`, `isNaN`, `isFinite`, `Infinity`, `NaN`
- **URI encoding:** `encodeURIComponent`, `decodeURIComponent`, `encodeURI`, `decodeURI`
- **Base64:** `atob`, `btoa`
- **Text encoding:** `TextEncoder`, `TextDecoder`
- **Binary/typed arrays:** `ArrayBuffer`, `DataView`, `Uint8Array`, `Uint16Array`, `Uint32Array`, `Int8Array`, `Int16Array`, `Int32Array`, `Float32Array`, `Float64Array`, `BigInt64Array`, `BigUint64Array`
- **Fetch API:** `URL`, `URLSearchParams`, `Headers`, `Request`, `Response`, `AbortController`, `AbortSignal`
- **Utilities:** `structuredClone`, `Intl`, `crypto.randomUUID`

**Not available:** `require`, `import`, `process`, `fs`, `eval`, `Function` constructor, `setTimeout`, `setInterval`, or any Node.js built-in modules.

### Security

The sandbox uses `node:vm` which prevents accidental access to Node.js internals but is not a security boundary against determined attackers. This is appropriate for a self-hosted platform where users are authenticated team members. `maxRetries` is set to 0 (fail-safe).

`fetch` is wrapped with an `AbortController` deadline matching the configured timeout, so network requests cannot hang indefinitely. A wall-clock `Promise.race` timeout also guards the entire execution, covering any async operation (not just fetch). Only `crypto.randomUUID` is exposed (`crypto.subtle` and other methods are not available).

### Network Egress Policy

`fetch` can reach any public internet destination over HTTP or HTTPS. To prevent server-side request forgery, the sandbox blocks requests whose resolved IP falls inside a private, internal, or reserved range. The block decision is **made on the resolved IP, not on the hostname** - DNS is consulted at request time and the result is checked against the denylist.

**Allowed**

- Any public IPv4 destination (e.g. `api.openai.com`, `api.coingecko.com`, `discord.com`, `slack.com`, `telegram.org`)
- Any public IPv6 destination
- Public IPv4 reached via NAT64 in dual-stack environments

**Blocked** (the request fails with an SSRF error before any packet leaves the sandbox)

| Category               | Examples                                                   |
| ---------------------- | ---------------------------------------------------------- |
| Loopback               | `127.0.0.0/8`, `::1`                                       |
| Link-local             | `169.254.0.0/16` (incl. cloud metadata endpoints), `fe80::/10` |
| Private (RFC 1918)     | `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`            |
| Carrier-grade NAT      | `100.64.0.0/10`                                            |
| Unique local (IPv6)    | `fc00::/7` (incl. `fd00::/8`)                              |
| Multicast              | `224.0.0.0/4`, `ff00::/8`                                  |
| Documentation/reserved | `192.0.2.0/24`, `198.51.100.0/24`, `203.0.113.0/24`, `240.0.0.0/4` |
| Benchmarking           | `198.18.0.0/15`                                            |
| Broadcast              | `255.255.255.255`                                          |
| Non-http(s) schemes    | `file://`, `data://`, `ftp://`, `gopher://`                |

NAT64-wrapped equivalents of the above (`64:ff9b::/96` plus an embedded private IPv4) are also blocked. A hostname that resolves to **any** address in these ranges is rejected — split-horizon DNS does not bypass the check.

**What you see on a block**

```
sandbox fetch: SSRF blocked (hostname -> resolved_ip)
```

This appears in the step's `error` field. The error indicates the destination IP class fell into one of the denied ranges; it does not mean the host is permanently unreachable, only that its current DNS resolution is.

**Choosing a dedicated plugin instead of `fetch`**

For common third-party services with rate limits, retries, or credential management, a dedicated plugin is usually a better choice than calling `fetch` directly. The platform ships first-class plugins for `discord/send-message`, `slack/send-message`, `telegram/send-message`, `sendgrid/send-email`, `webhook/send-webhook`, and others — they handle authentication, rate-limit backoff, and structured field validation that you would otherwise reimplement in user code.

## Example Workflows

### Filter and Aggregate Transfer Events

Filter large transfers from an event query and compute totals for an alert.

```
Trigger (Event: Transfer)
-> Query Events: get recent transfers

-> Run Code (Analyze Transfers):
     const events = {{QueryEvents.events}};
     const threshold = BigInt('1000000000000000000'); // 1 ETH in wei
     const large = events.filter(e => BigInt(e.value) > threshold);
     const total = large.reduce((sum, e) => sum + BigInt(e.value), 0n);
     return {
       count: large.length,
       total: total.toString(),
       addresses: large.map(e => e.from)
     };

-> Condition: {{@code:Run Code.result.count}} > 0
-> Discord: "{{@code:Run Code.result.count}} large transfers totaling {{@code:Run Code.result.total}} wei"
```

### Fetch External Price Data

Call an external API from within the code node and format the result.

```
Trigger (Schedule, every 5m)
-> Read Contract (Oracle): latestAnswer on price feed

-> Run Code (Enrich Price):
     const onChainPrice = {{ReadContract.result}};
     const res = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd');
     const data = await res.json();
     const marketPrice = data.ethereum.usd;
     const oraclePrice = Number(onChainPrice) / 1e8;
     const deviation = Math.abs(oraclePrice - marketPrice) / marketPrice * 100;
     return {
       oraclePrice: oraclePrice.toFixed(2),
       marketPrice: marketPrice.toFixed(2),
       deviationPct: deviation.toFixed(2)
     };

-> Condition: {{@code:Run Code.result.deviationPct}} > 5
-> Discord: "Oracle deviation: {{@code:Run Code.result.deviationPct}}% (oracle: ${{@code:Run Code.result.oraclePrice}}, market: ${{@code:Run Code.result.marketPrice}})"
```

### Format Complex Alert Payload

Build a structured notification payload from multiple upstream nodes.

```
Trigger (Webhook)
-> Database Query: get user preferences
-> Read Contract: get current token balance

-> Run Code (Build Alert):
     const user = {{DatabaseQuery.rows}}[0];
     const balance = {{ReadContract.result}};
     const balanceEth = (Number(balance) / 1e18).toFixed(4);
     const timestamp = new Date().toISOString();
     const msg = [
       `Wallet: ${user.wallet_address}`,
       `Balance: ${balanceEth} ETH`,
       `Threshold: ${user.alert_threshold} ETH`,
       `Time: ${timestamp}`
     ].join('\n');
     return { message: msg, shouldAlert: Number(balanceEth) < user.alert_threshold };

-> Condition: {{@code:Run Code.result.shouldAlert}} == true
-> SendGrid: send email with {{@code:Run Code.result.message}}
```

### Deduplicate and Rank Events

Process a batch of events to remove duplicates and rank by value.

```
Trigger (Schedule, hourly)
-> Query Events: get last hour of Swap events

-> Run Code (Process Swaps):
     const swaps = {{QueryEvents.events}};
     // Deduplicate by transaction hash
     const seen = new Set();
     const unique = swaps.filter(s => {
       if (seen.has(s.transactionHash)) return false;
       seen.add(s.transactionHash);
       return true;
     });
     // Sort by value descending
     unique.sort((a, b) => Number(BigInt(b.value) - BigInt(a.value)));
     // Take top 10
     const top = unique.slice(0, 10).map((s, i) => ({
       rank: i + 1,
       tx: s.transactionHash,
       value: (Number(s.value) / 1e18).toFixed(4)
     }));
     return { total: unique.length, duplicatesRemoved: swaps.length - unique.length, top };

-> Discord: "{{@code:Run Code.result.total}} unique swaps ({{@code:Run Code.result.duplicatesRemoved}} dupes removed)"
```

### Webhook Payload Transformation

Reshape incoming webhook data into the format expected by a downstream API.

```
Trigger (Webhook): receives { "alerts": [...], "source": "grafana" }

-> Run Code (Transform):
     const payload = {{Webhook.input}};
     const alerts = payload.alerts || [];
     const critical = alerts.filter(a => a.severity === 'critical');
     const summary = critical.map(a => ({
       title: a.labels.alertname,
       description: a.annotations.description,
       startsAt: a.startsAt
     }));
     // Base64 encode for downstream API that expects it
     const encoded = btoa(JSON.stringify(summary));
     return { count: critical.length, summary, encoded };

-> Condition: {{@code:Run Code.result.count}} > 0
-> HTTP Request: POST to incident API with body {{@code:Run Code.result.encoded}}
```

### Multi-Source Data Join

Combine data from a database query and a contract read into a unified view.

```
Trigger (Schedule, daily)
-> Database Query: get monitored addresses with labels
-> For Each: iterate addresses
   -> Read Contract (Balance): balanceOf for each address

-> Run Code (Join Results):
     const addresses = {{DatabaseQuery.rows}};
     const balances = {{ForEach.results}};
     const report = addresses.map((addr, i) => {
       const bal = balances[i]?.result ?? '0';
       const balFormatted = (Number(bal) / 1e18).toFixed(4);
       return { label: addr.label, address: addr.address, balance: balFormatted };
     });
     const totalBal = report.reduce((s, r) => s + parseFloat(r.balance), 0);
     report.sort((a, b) => parseFloat(b.balance) - parseFloat(a.balance));
     return { report, totalBalance: totalBal.toFixed(4), walletCount: report.length };

-> Discord: "Daily report: {{@code:Run Code.result.walletCount}} wallets, total {{@code:Run Code.result.totalBalance}} ETH"
```

### Anomaly Detection with Rolling Window

Compare the current value against a historical average to detect anomalies.

```
Trigger (Event: Transfer)
-> Database Query: get last 24h transfer values

-> Run Code (Detect Anomaly):
     const history = {{DatabaseQuery.rows}};
     const currentValue = {{Trigger.value}};
     if (history.length < 5) {
       return { isAnomaly: false, reason: 'insufficient data' };
     }
     const values = history.map(r => Number(r.value));
     const mean = values.reduce((s, v) => s + v, 0) / values.length;
     const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
     const stdDev = Math.sqrt(variance);
     const zScore = Math.abs((Number(currentValue) - mean) / stdDev);
     return {
       isAnomaly: zScore > 3,
       zScore: zScore.toFixed(2),
       mean: mean.toFixed(2),
       stdDev: stdDev.toFixed(2),
       currentValue: Number(currentValue).toFixed(2)
     };

-> Condition: {{@code:Run Code.result.isAnomaly}} == true
-> Discord: "Anomaly detected: value {{@code:Run Code.result.currentValue}} (z-score: {{@code:Run Code.result.zScore}}, mean: {{@code:Run Code.result.mean}})"
```
