---
title: "Data Plugin"
description: "Reshape workflow data without writing a script: encode and decode strings, convert numbers between decimal and hex, hash values, extract named fields, flatten findings, and hold static config."
---

# Data Plugin

Five nodes that cover the data-shaping work that would otherwise go into a Code node. No credentials or setup required -- these are pure computation nodes.

## Actions

| Action | Description |
| ------ | ----------- |
| Encode / Decode | Convert text to padded hex (bytes8/16/32), raw hex or base64, and back; convert numbers between decimal and hex |
| Extract Fields | Pick named values out of upstream node output by dotted path |
| Flatten Findings | Merge several monitoring results into one labelled findings list |
| Hash | Hash a value one way with keccak256, SHA-2, SHA3-256, RIPEMD-160 or BLAKE2b; optionally truncate and pad to a selector or an event topic |
| Static Config | Hold static JSON configuration on the canvas |

---

## Encode / Decode

Converts a string, or a JSON array of strings, between text and a hex or base64 representation, or converts a number between decimal and hex. The common cases are producing the `bytes32` form of a short name for a contract call, and turning a decimal amount into the `uint256` word a contract argument expects.

### Inputs

| Input | Required | Description |
| ----- | -------- | ----------- |
| operation | Yes | `encode` (text to hex/base64), `decode` (hex/base64 to text), `decimal-to-hex` (number to hex) or `hex-to-decimal` (hex to number). Default `encode` |
| value | Yes | A single value, or a JSON array of values to convert in one step |
| format | Yes | `encode` and `decode` only. `bytes32`, `bytes16`, `bytes8`, `hex` (no padding) or `base64`. Default `bytes32` |
| numberFormat | No | `decimal-to-hex` only. `hex` (minimal, `0xff`), `uint256`, `uint128` or `uint64` (left-padded word of that width). Default `hex` |
| padding | No | `encode` and `decode` with a fixed-size format only. `right` (Solidity string to bytesN, the default) or `left` (numeric, big-endian) |

The editor shows only the inputs that apply to the selected operation. `hex-to-decimal` needs nothing beyond `value`: leading zeros do not change a number, so a padded word and its minimal form give the same result.

### Outputs

| Output | Description |
| ------ | ----------- |
| result | The converted value: a string for a single input, an array for an array input |
| map | Object keyed by each original value, holding its converted value |
| count | Number of values converted |
| operation | `encode`, `decode`, `decimal-to-hex` or `hex-to-decimal` |
| format | The format that was used: the text format for `encode` and `decode`, the chosen `numberFormat` for `decimal-to-hex`. Absent for `hex-to-decimal`, which has no format |
| error | Error message if the conversion failed |

### Notes

- Encoding a value that does not fit the chosen size fails the step rather than truncating.
- `hex` applies no padding, so `SKY` becomes `0x534b59`.
- Decoding strips the zero padding from the side named by `padding`, so a round trip through `bytes32` returns the original string.
- `decimal-to-hex` accepts a non-negative integer of any size and always pads on the left, so `255` with `uint256` becomes `0x00...00ff`. Negative numbers, fractions and text fail the step, as does a number too large for the chosen width.
- `hex-to-decimal` accepts hex with or without the `0x` prefix and returns the number as a decimal string, so values above 2^53 stay exact when passed on as a contract argument or into a template.

### Examples

```
-> Encode / Decode (Encode Networks):
     operation: encode
     value: ["SKY"]
     format: bytes32
-> Read Contract:
     args: {{@encode:Encode Networks.map.SKY}}
```

```
-> Encode / Decode (Amount Word):
     operation: decimal-to-hex
     value: {{@config:Static Config.result.amount}}
     numberFormat: uint256
-> Write Contract:
     args: {{@encode:Amount Word.result}}
```

```
-> Encode / Decode (Balance):
     operation: hex-to-decimal
     value: {{@call:Raw Call.result}}
-> Condition:
     {{@encode:Balance.result}} > 1000000
```

---

## Extract Fields

Pulls named values out of an upstream node's output by dotted path. A missing path returns `null` by default, so a partial fetch degrades instead of aborting the run.

### Inputs

| Input | Required | Description |
| ----- | -------- | ----------- |
| source | Yes | A single upstream output, or a JSON object combining several |
| paths | Yes | One path per line. `name = path` renames the output; a bare path keeps its last segment as the name |
| mode | No | `object` (single value, the default) or `array` (apply the paths to every item) |
| onMissing | No | `null` (default), `empty` (empty string) or `fail` (fail the step) |

### Outputs

| Output | Description |
| ------ | ----------- |
| fields | Object of the extracted values, keyed by name (object mode) |
| items | Array of extracted objects, one per source item (array mode) |
| missing | Names whose path was not found |
| foundCount | Number of paths resolved |
| itemCount | Number of source items processed |
| error | Error message if extraction failed |

### Notes

- Numeric segments index into arrays, so `rows.1.amount` reads the second row.
- To read from several upstream nodes at once, build a JSON object in `source`:
  `{"chainlog": {{@a:Chainlog.data}}, "setup": {{@b:Setup.result}}}`, then use paths like `chainlog.vat`.
- Use this node rather than reaching into a nested path inside a template reference on an opaque node output, which cannot be validated before the run.

### Example

```
-> HTTP Request (Chainlog)
-> Extract Fields:
     source: {{@chainlog:Chainlog.data}}
     paths:
       vat = result.vat
       jug = result.jug
       spotter = result.spotter
-> Read Contract:
     contractAddress: {{@fields:Extract Fields.fields.vat}}
```

---

## Flatten Findings

Takes several monitoring results, flattens them into one findings list with per-source labels and severities, and reports whether anything was found.

### Inputs

| Input | Required | Description |
| ----- | -------- | ----------- |
| sources | Yes | JSON array of sources. Each entry needs a `label` and a `value`; `severity` and `itemsPath` are optional per entry |
| defaultSeverity | No | Severity for sources without their own. Default `warning` |
| hashField | No | Dotted path inside each finding to read a transaction hash from. Default `transactionHash` |
| maxFindings | No | Cap on the `findings` array. Default 100 |

A source `value` accepts:

| Value shape | Findings produced |
| ----------- | ----------------- |
| Object with `events`, `transactions`, `logs`, `rows`, `items` or `results` | One per element of the first array found |
| Array | One per element |
| `true` | One finding, `{ triggered: true }` |
| `false`, `null`, `0`, empty string | None |
| Any other object | One finding holding the object |

Set `itemsPath` on an entry to point at a nested array instead.

### Outputs

| Output | Description |
| ------ | ----------- |
| anyFound | True when at least one source produced a finding |
| count | Total number of findings, before any cap |
| findings | Array of `{ label, severity, hash, item }` |
| labels | Labels of the sources that produced findings |
| firstHash | The first transaction hash found, or `null` |
| summary | Human-readable per-label summary for an alert body |
| truncated | True when `findings` was capped by `maxFindings` |
| error | Error message if the scan failed |

### Example

```
-> Query Events (File Changes)
-> Query Events (Owner Calls)
-> Flatten Findings:
     sources:
       [
         {"label": "File changed", "value": {{@files:File Changes.result}}},
         {"label": "Owner call", "value": {{@owner:Owner Calls.result}}, "severity": "critical"}
       ]
-> Condition: {{@scan:Flatten Findings.anyFound}} == true
-> Discord: "{{@scan:Flatten Findings.summary}}"
```

---

## Hash

Hashes a string, or a JSON array of strings, one way. Unlike Encode / Decode the result cannot be turned back into the input. The common cases are deriving a function selector or an event topic for a raw log filter, and hashing a byte payload that reached the workflow already encoded.

### Inputs

| Input | Required | Description |
| ----- | -------- | ----------- |
| algorithm | Yes | `keccak256` (default), `sha256`, `sha512`, `sha3-256`, `ripemd160` or `blake2b-256` |
| value | Yes | A single value, or a JSON array of values to hash in one step |
| inputEncoding | Yes | `utf8` (hash the characters, the default), `hex` (hash the bytes) or `base64` (decode, then hash the bytes) |
| outputBytes | No | Keep only the first N bytes of the digest. Blank for the whole digest |
| padTo | No | Right-pad the result with zero bytes to this width. Blank for no padding |
| outputFormat | No | `hex`, 0x-prefixed (the default), `base64` or `base64url` (URL-safe, unpadded) |

### Outputs

| Output | Description |
| ------ | ----------- |
| result | The digest: a string for a single input, an array for an array input |
| map | Object keyed by each original value, holding its digest |
| count | Number of values hashed |
| algorithm | The algorithm that was used |
| digestBytes | Width of each digest in bytes, after any truncation and padding |
| error | Error message if hashing failed |

### Notes

- `keccak256` is the hash the EVM uses: function selectors and event topics, including the topic that carries an indexed `string` or `bytes` argument. It is the default because almost every on-chain use wants it.
- **`sha3-256` is not `keccak256`.** Ethereum adopted Keccak before NIST finalised SHA-3, and NIST then changed the padding byte. The two give unrelated results for the same input, and the wrong one is a perfectly valid hash that simply matches nothing on chain. Pick `sha3-256` only if a non-EVM protocol asked for it by that name.
- `inputEncoding` is never inferred from a leading `0x`. Given `0x1234`, `utf8` hashes the six characters and `hex` hashes the two bytes; both succeed and disagree. Signatures are `utf8`; a raw byte payload from an upstream node is `hex`.
- `hex` requires a whole number of bytes. `0x123` is refused rather than read as `0x0123`, because which nibble is missing is the caller's to say, not the node's to guess.
- `base64` input is for a payload that arrived encoded -- a webhook body, a signed blob -- where decoding it to text first would corrupt any byte that is not valid UTF-8. It accepts either alphabet, standard or URL-safe, with or without padding, but not a mixture of the two, and it refuses a non-canonical final character rather than decoding it silently. Line breaks are stripped, so MIME-wrapped input from `openssl base64` or a PEM body works as it stands.
- `base64url` output swaps `+` and `/` for `-` and `_` and drops the padding, so a digest can go into a URL, a filename or a header without further escaping.
- For a digest as a decimal number, feed the `hex` output into Encode / Decode with `hex-to-decimal`, which stays exact above 2^53. There is no decimal output format because that composition already covers it.
- `outputBytes: 4` turns a function signature into its selector. Adding `padTo: 32` turns that selector into the `bytes32` topic that filters an anonymous `LogNote` event -- padding is on the right because that is where the EVM puts it, with the selector left-aligned in the topic word.
- **A truncated digest is not the shorter standard hash of the same family.** BLAKE2 mixes the output length into its initial state (RFC 7693), and SHA-512/256 has its own initial values, so `sha512` cut to 32 bytes is a truncated SHA-512 and nothing else -- not SHA-512/256. Truncate for a selector; pick the algorithm you want otherwise.
- Truncating beyond the digest width, or padding to less than the value would occupy, fails the step rather than producing a silently wrong value.
- Digest widths: `ripemd160` is 20 bytes, `sha512` is 64, the rest are 32.
- An empty value is hashed rather than refused. `keccak256` of nothing is `0xc5d24601...`, which `EXTCODEHASH` returns for an account that exists with no code, so it is a value worth being able to produce.
- A single value is trimmed, so a textarea that picked up a trailing newline cannot change the digest. Array elements are not trimmed, so `["  a  "]` is how to hash a value whose surrounding whitespace matters.
- An option the node does not recognise is refused, not silently replaced with the default. A blank one still falls back, so a node saved before a field existed keeps working, but `algorithm: md5` fails rather than quietly hashing with keccak256.
- An empty array is refused rather than returning `count: 0`, and an array entry with no unambiguous text form -- an object, `null` -- is refused naming its position. Numbers and booleans are accepted.
- Widths are capped at 1024 bytes and arrays at 1000 entries, so a slipped keypress produces a message rather than a huge allocation. A width must be written in plain decimal digits: `1e3` and `0x20` are refused rather than read as 1000 and 32.
- `map` is keyed by the original value, so two identical entries share one key while `count` still reports both. A single-entry array returns `result` as a string rather than an array, matching Encode / Decode.
- `base64` input accepts at most two padding characters and only where they complete the final group, so `YWJj=` and `YWJjZA=` are refused rather than decoded as though the padding were absent.
- Signatures must be canonical: no parameter names, no spaces, and `int` written as `int256`. `fork(bytes32,address,address,int256,int256)` takes five parameters, not six. A wrong signature yields a valid-looking selector that matches no logs and raises no error, so check it against the contract ABI.

### Examples

Derive the `bytes32` topic for a raw `eth_getLogs` filter on an anonymous event:

```
-> Hash (Frob Topic):
     algorithm: keccak256
     value: frob(bytes32,address,address,address,int256,int256)
     inputEncoding: utf8
     outputBytes: 4
     padTo: 32
-> HTTP Request (eth_getLogs):
     topics: [["{{@hash:Frob Topic.result}}"]]
```

Derive `topic0` for a named event:

```
-> Hash (Transfer Topic):
     algorithm: keccak256
     value: Transfer(address,address,uint256)
-> HTTP Request (eth_getLogs):
     topics: [["{{@hash:Transfer Topic.result}}"]]
```

Match an indexed `string` or `bytes` event argument. The ABI spec stores the
Keccak hash of those in the topic, not the value, so the filter needs the hash:

```
-> Hash (Event Topic):
     algorithm: keccak256
     value: Registered(string,address)
-> Hash (Name Topic):
     algorithm: keccak256
     value: {{@config:Static Config.result.name}}
     inputEncoding: utf8
-> HTTP Request (eth_getLogs):
     topics: ["{{@event:Event Topic.result}}", "{{@name:Name Topic.result}}"]
```

Hash the raw value, not an ABI-encoded form: the spec encodes indexed `bytes`
and `string` in place, as raw contents with no padding and no length prefix.

Hash bytes rather than text, taking the input from Encode / Decode:

```
-> Encode / Decode (Amount Word):
     operation: decimal-to-hex
     value: {{@config:Static Config.result.amount}}
     numberFormat: uint256
-> Hash (Commitment):
     algorithm: keccak256
     value: {{@encode:Amount Word.result}}
     inputEncoding: hex
```

Note that `hex` takes one run of hex digits, with the `0x` prefix only at the
front. There is no node that concatenates two hex values, so a derivation over
several packed words -- `keccak256(key . slot)` for a mapping storage slot, or a
CREATE2 salt -- cannot be assembled from this plugin today.

Hash a payload that arrived base64-encoded, then emit the digest URL-safe:

```
-> HTTP Request (Fetch Payload)
-> Extract Fields (Encoded Body):
     source: {{@fetch:Fetch Payload.data}}
     paths:
       body = result.bodyBase64
-> Hash (Body Digest):
     algorithm: sha256
     value: {{@fields:Encoded Body.fields.body}}
     inputEncoding: base64
     outputFormat: base64url
-> HTTP Request:
     endpoint: https://example.test/verify?digest={{@digest:Body Digest.result}}
```

Hash several values at once and read them back by name:

```
-> Hash (Selectors):
     algorithm: keccak256
     value: ["Transfer(address,address,uint256)", "Approval(address,address,uint256)"]
-> Condition:
     {{@log:Raw Log.topics.0}} == {{@hash:Selectors.map.Transfer(address,address,uint256)}}
```

---

## Static Config

Holds a static JSON value on the canvas -- an address book, a constant set, a wallet registry -- so it is visible and editable without a script wrapper.

### Inputs

| Input | Required | Description |
| ----- | -------- | ----------- |
| value | Yes | Any JSON value |

### Outputs

| Output | Description |
| ------ | ----------- |
| result | The configuration value |
| keys | Top-level keys when the value is an object |
| count | Number of keys for an object, or entries for an array |
| valueType | `object`, `array` or `primitive` |
| error | Error message if the JSON is invalid |

### Example

```
-> Static Config (Contracts):
     value: {"vat": "0x35D1...", "jug": "0x19c0..."}
-> Read Contract:
     contractAddress: {{@contracts:Contracts.result.vat}}
```

Pair with a For Each node to iterate a registry:

```
-> Static Config (Wallets):
     value: [{"name": "Ops", "address": "0xA..."}, {"name": "Treasury", "address": "0xB..."}]
-> For Each:
     arraySource: {{@wallets:Wallets.result}}
```
