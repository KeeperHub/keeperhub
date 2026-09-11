---
title: "Data Plugin"
description: "Reshape workflow data without writing a script: encode and decode strings, extract named fields, flatten findings, and hold static config."
---

# Data Plugin

Four nodes that cover the data-shaping work that would otherwise go into a Code node. No credentials or setup required -- these are pure computation nodes.

## Actions

| Action | Description |
| ------ | ----------- |
| Encode / Decode | Convert text to padded hex (bytes8/16/32), raw hex or base64, and back |
| Extract Fields | Pick named values out of upstream node output by dotted path |
| Flatten Findings | Merge several monitoring results into one labelled findings list |
| Static Config | Hold static JSON configuration on the canvas |

---

## Encode / Decode

Converts a string, or a JSON array of strings, between text and a hex or base64 representation. The common case is producing the `bytes32` form of a short name for a contract call.

### Inputs

| Input | Required | Description |
| ----- | -------- | ----------- |
| operation | Yes | `encode` (text to hex/base64) or `decode` (hex/base64 to text). Default `encode` |
| value | Yes | A single value, or a JSON array of values to convert in one step |
| format | Yes | `bytes32`, `bytes16`, `bytes8`, `hex` (no padding) or `base64`. Default `bytes32` |
| padding | No | `right` (Solidity string to bytesN, the default) or `left` (numeric, big-endian). Fixed-size formats only |

### Outputs

| Output | Description |
| ------ | ----------- |
| result | The converted value: a string for a single input, an array for an array input |
| map | Object keyed by each original value, holding its converted value |
| count | Number of values converted |
| operation | `encode` or `decode` |
| format | The format that was used |
| error | Error message if the conversion failed |

### Notes

- Encoding a value that does not fit the chosen size fails the step rather than truncating.
- `hex` applies no padding, so `SKY` becomes `0x534b59`.
- Decoding strips the zero padding from the side named by `padding`, so a round trip through `bytes32` returns the original string.

### Example

```
-> Encode / Decode (Encode Networks):
     operation: encode
     value: ["SKY"]
     format: bytes32
-> Read Contract:
     args: {{@encode:Encode Networks.map.SKY}}
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
