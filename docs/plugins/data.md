---
title: "Data Plugin"
description: "Reshape workflow data without writing a script: encode and decode strings, convert numbers between decimal and hex, hash values, extract named fields, filter arrays, flatten findings, and hold static config."
---

# Data Plugin

Six nodes that cover the data-shaping work that would otherwise go into a Code node. No credentials or setup required -- these are pure computation nodes.

## Actions

| Action | Description |
| ------ | ----------- |
| Encode / Decode | Convert text to padded hex (bytes8/16/32), raw hex or base64, and back; convert numbers between decimal and hex |
| Extract Fields | Pick named values out of upstream node output by dotted path |
| Filter Array | Keep the items of an array that pass a test, pull one field out of every match, and report each match's position and the items that could not be tested |
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

## Filter Array

Keeps only the items of an array that pass a test, and pulls one field out of every match into a flat array. It also reports where each match sits in the source, an optional label for each match, and how many items the test could not apply to, so a Condition after it can branch on **count**, check **values**, name what matched with **labels**, or alert on **skipped**.

### Inputs

| Input | Required | Description |
| ----- | -------- | ----------- |
| Source | Yes | A JSON array, usually an upstream array field such as `{{@batch:Batch Read Contract.results}}`. Up to 10,000 items; a larger array fails the step rather than being cut short |
| Field to test | No | Dotted path inside each item, e.g. `success`, `meta.name` or `topics.1` (a number picks a list entry). A path with an empty part such as `a..b` is refused. Blank tests each item itself, for an array of names or numbers. Hidden for **No test: keep every item** |
| Operator | Yes | The test, chosen from the groups below. Default **General: equals** |
| Value | For tests that compare | What each item is compared with. See How Value is read |
| Ignore case | No | Off by default; from the API, `true` or `false`. When on, text is matched whatever its letter case. Applies to equals, not equals, soft equals, soft not equals, contains, starts with, ends with, matches regex, their **does not** forms and **Array: contains** |
| Return field | No | Dotted path pulled from each match into **values**. Blank uses Field to test. With Return field blank and either Field to test blank or **keep every item**, **values** holds the matching items themselves |
| If a match has no Return field | No | **Keep it, with null in values** (default) or **Fail the step**. Either way the match is counted in **missingReturn**, so a mistyped Return field shows up |
| Labels | No | A JSON array as long as Source, in the same order, e.g. the names of the contracts a batch read was given. The entry at each position comes out in **labels** for matches and **skippedLabels** for skipped items. A different length fails the step, and is refused at save when both are typed |
| If an item can't be tested | No | **Fail the step** (default) or **Skip it and count it in skipped**. See Items a test can't apply to |

### Operators

| Group | Operators |
| ----- | --------- |
| General | equals, not equals, soft equals, soft not equals, exists, does not exist, is null, is not null, is undefined, is not undefined |
| Text | contains, does not contain, starts with, does not start with, ends with, does not end with, matches regex, does not match regex, is empty, is not empty |
| Number | greater than, greater than or equal, less than, less than or equal |
| Boolean | is true, is false |
| Array | is empty, is not empty, contains, length |
| Object | is empty, has key |
| No test | keep every item |

Each operator in the list shows a one-line hint under its name. Once chosen, an operator whose name repeats across groups shows with its group, e.g. **Text: contains** or **Array: contains**; the others show their name alone. Condition's operator list does the same. Error messages always name the group.

- **equals** compares by value: `"1.0"` equals `1`, and integers of any size written as text compare exactly. `"true"` does not equal `true`.
- **soft equals** compares loosely, as JavaScript `==` does: `"0"` soft equals `0`, and hex text such as `"0x01"` soft equals `1`. Pick it only when items mix numbers, text and booleans on purpose.
- The **does not** tests keep the text and number items that fail the matching test. Starts with `MCD_CLIP_` followed by a second Filter Array with does not start with `MCD_CLIP_CALC_` keeps the clippers without their calculators.
- **matches regex** and **does not match regex** test the text against a regular expression, anywhere in it unless anchored: `^` marks the start and `$` the end. `^EMSP_` keeps names that start with `EMSP_`, and `^EMSP_(SPBEAM|LINE)_` keeps two families. From the API the operators are `matchesRegex` and `notMatchesRegex`.
  - **Value** is the pattern exactly as it should run, with backslashes as typed; only spaces at either end are trimmed (write `[ ]` or `\x20` to match one). Leave out quotes and JavaScript's `/.../i` around it: a pattern that is one quoted string, or slashes with flags or regex syntax inside, is refused. A plain path such as `/api/` is fine. To match a quote, put a backslash before it. The pattern must be typed into Value, not taken from another node; to look for text from another node, use **contains** or **starts with**. Both rules are checked when the workflow is saved.
  - Only text and numbers are tested; `null`, `true`/`false`, lists and objects are items the test can't apply to (a Condition tests `null` and booleans as their text).
  - **Ignore case**, or a leading `(?i)`, ignores letter case.
  - **Syntax:** [RE2](https://github.com/google/re2/wiki/Syntax), close to JavaScript's. Lookahead, lookbehind, back-references and `\u` escapes are not supported and get a message naming them; other refused syntax quotes RE2's own message. `\s` does not match a non-breaking space.
  - **Limits:** a pattern of up to 512 characters and size 1,000 (RE2 counts the steps it compiles to; long `{n}` repeats add up fastest), and 4,096 characters of text per item. Each Filter Array node has a matching budget of 25,000,000: the pattern's size times the characters tested, added up over the items. That keeps it from holding up a run for more than a few seconds; a node that reaches it fails, even in skip mode, and the message gives the pattern's steps. What fits: 10,000 addresses with `^0x[0-9a-fA-F]{40}$` (46 steps x 42 characters each, about 19 million), or any number of Chainlog names with `^EMSP_` (8 steps). What does not: 10,000 transaction hashes with `^0x[0-9a-f]{64}$` (70 x 66 each, about 46 million). About 5,400 of those fit, so split the list across two Filter Array nodes, or test with **starts with** `0x`.

### How Value is read

- Spaces around Value are trimmed; quote it to keep them, e.g. `" EMSP_"` (under matches regex, write `[ ]` instead: quotes would be part of the pattern).
- **Text tests and has key**: the text as typed, so `007` stays `007`. Except under matches regex, which keeps quotes as part of the pattern, surrounding quotes are removed, and inside double quotes escapes such as `\n` and `\"` work as in a Condition.
- When Value is left empty, the error says what this test needs: a number, a whole number, a key, a pattern, or `""` for empty text.
- **Number tests**: a decimal number such as `100`, `-5` or `1.5`, or hex written with a lowercase `0x` such as `0x64`, up to 100 characters. Exponents (`1e3`), `0X64` and negative hex are not numbers. Anything else fails the step, and is refused when the workflow is saved. Integers of any size compare exactly, so a rad-scale threshold can be typed in full.
- **Array: length**: a whole number such as `3`, small enough to count exactly. Anything else is refused when the workflow is saved.
- A Value, Source or Labels built from a template (`{{...}}`) is checked when the step runs, since its content is only known then; one typed by hand is checked when the workflow is saved.
- **Every other test**: as in a Condition. `5` is a number, `true` and `false` are booleans, `null` is null, anything else is text. Quote it to force text, e.g. `"true"` matches the text `true` but not the boolean. Quoting a number changes nothing under equals, which compares numbers by value.
- Hex text such as `0x1f` is text under equals, so `"0x01"` does not equal `"0x1"`. Number tests and soft equals read it as a number.
- Text is case-sensitive unless Ignore case is on, so a checksummed address does not equal its lowercase form by default.
- From the API, a number Value too large to be exact (past 2^53) is refused; send it as text instead.

### Items a test can't apply to

Each test only looks at items it applies to:

- number tests at numbers, numeric text and hex
- text tests, including the **does not** forms, at text and numbers; matches regex also needs the text to be at most 4,096 characters
- boolean tests (is true, is false) at `true` and `false` only
- array tests at lists, object tests at objects
- soft equals and soft not equals at single values, not lists or objects
- every test except the presence ones (exists, does not exist, is null, is not null, is undefined, is not undefined, is empty, is not empty) needs the field to be there

By default such an item fails the step: a reverted Batch Read Contract call comes back with `result: null`, so under **is true** or **less than** it stops the run rather than reading as "not cast" or as a low value. Someone who can make a monitored read revert cannot make the monitor pass quietly. A failed step marks the run as failed in Runs, and workflow failure alerts report it if they are set up; the next scheduled run starts as usual.

Set **If an item can't be tested** to **Skip it and count it in skipped** to keep the run going. Skipped items are neither kept nor dropped silently: they are counted in **skipped**, with their positions in **skippedIndexes** and their Labels entries in **skippedLabels**. A monitor in skip mode must branch on `skipped > 0`, or a failed read hides what it was meant to catch.

### Outputs

| Output | Description |
| ------ | ----------- |
| success | Whether filtering succeeded |
| items | The items that passed the test |
| values | The Return field of each match, as a flat array (`null` where a match has no such field) |
| indexes | The source position of each match, counting from 0 |
| labels | The Labels entry of each match, e.g. the clipper that tripped (empty when Labels is not set) |
| count | Number of matching items |
| skipped | Number of items the test could not apply to (skip mode) |
| skippedIndexes | The source position of each skipped item |
| skippedLabels | The Labels entry of each skipped item, e.g. the spell whose read failed (empty when Labels is not set) |
| missingReturn | Number of matching items without the Return field. Their entry in **values** is `null`, as is a Return field that holds `null`; only this count tells the two apart. A mistyped Return field shows up here |
| total | Number of items in the source |
| error | Error message if filtering failed |

### Notes

- **is true** matches only the boolean `true`, not the text `"true"` or `1`.
- One node runs one test. For two tests, such as success is true and result is true, chain two Filter Array nodes.
- Source must be an array. A single value, such as Encode / Decode's result for one input, fails with a message saying so.
- Value is always compared as data. A value resolved from an upstream node cannot change the test. For matches regex, Value is the test itself, so it must be typed.
- Settings the form hides for the chosen operator are ignored, so a leftover value cannot change or fail the step.
- Settings typed by hand are checked when the workflow is saved with the same rules the step uses; a setting that comes from another node is checked when the run resolves it.

### Examples

List the Chainlog's emergency spells, the `EMSP_` keys:

```
-> Filter Array:
     Source: {{@decode:Encode / Decode.result}}
     Operator: Text: starts with
     Value: EMSP_
```

**values** holds the matching names. These keys stand in the Chainlog all the time, so alerting on `count > 0` here would fire on every run. Alert on `count == 0` here instead: an empty list means the Chainlog read or the decode went wrong. To detect a cast, read each spell's `done()` with Batch Read Contract and filter that, as below.

Alert when any spell has been cast:

```
-> Static Config (Spell names):
     value: ["EMSP_SPBEAM_HALT", "EMSP_LINE_WIPE"]
-> Batch Read Contract (Mixed mode): done() on each spell's address, one call per spell, in the same order
-> Filter Array:
     Source: {{@batch:Batch Read Contract.results}}
     Field to test: result
     Operator: Boolean: is true
     Labels: {{@names:Spell names.result}}
     If an item can't be tested: Skip it and count it in skipped
-> Condition: {{@filter:Filter Array.count}} > 0
   -> Discord: Spells cast: {{@filter:Filter Array.labels}}
-> Condition: {{@filter:Filter Array.skipped}} > 0
   -> Discord: Could not read done() for {{@filter:Filter Array.skippedLabels}}
```

The two Conditions are parallel branches from Filter Array, so each alert fires on its own. Batch Read Contract's calls are rows added in the editor, so Labels is a matching list of names kept beside it, in the same order, since Labels is matched to Source by position. A new emergency spell needs both a new call and a new name; a different length fails the step rather than mislabelling. **labels** then names each cast spell and **skippedLabels** each spell whose `done()` reverted, so a failed read is never reported as a cast. A list shows in a message as JSON, e.g. `["EMSP_LINE_WIPE"]`. To notice a spell the monitor does not read yet, alert when the Chainlog list above and Spell names differ in length: `{{@filter:Emergency spells.count}} != {{@names:Spell names.count}}`, with the first Filter Array named Emergency spells.

If every spell shows up in **skipped**, check what `result` holds: a function whose single output is named returns `{ name: value }`, so Field to test becomes `result.<name>`.

`done()` stays true once a spell is cast, so the cast alert repeats on every run until the spell is handled and the workflow is changed or turned off.

This monitor sets **Skip** on purpose. With the default **Fail the step**, one reverted `done()` fails the whole step, so the cast alert for every other spell in that run would not go out; only a run-failure alert would, and only if failure alerts are set up.

Pull every result into a flat list, failed calls included:

```
-> Filter Array:
     Source: {{@batch:Batch Read Contract.results}}
     Operator: No test: keep every item
     Return field: result
```

**values** is `[false, true, null]` for three calls where the last one reverted. **keep every item** never skips, so a reverted call shows up only as `null` in **values**: check for it, or use the **is true** route above for alerting.

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
