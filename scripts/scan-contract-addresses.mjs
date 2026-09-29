#!/usr/bin/env node
// Scans a pull request's added lines for Ethereum and Solana addresses.
//
// Used by .github/workflows/contracts-checked.yml to decide whether the
// `contracts-checked` label is required. Runnable locally against any range:
//
//   node scripts/scan-contract-addresses.mjs --base origin/staging --head HEAD
//
// Only ADDED lines are scanned, and only in the three-dot range, so base
// drift never registers as the contributor's work.
//
// An address that already exists anywhere on the base branch is not
// reported: it has been through this gate once already, so moving or
// reformatting a file that contains it does not re-trigger the label.
//
// Solana candidates are base58-decoded and kept only when they decode to
// exactly 32 bytes, which is the length of an ed25519 public key. Matching
// the base58 alphabet by shape alone flags a wide range of ordinary
// identifiers; the decode is what makes the Solana half usable.

import { execFileSync } from "node:child_process";

const BASE58 =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

// 0x followed by exactly 40 hex digits. The trailing boundary keeps a
// 32-byte hash (64 hex digits) from matching its own first 40.
const EVM_RE = /\b0x[0-9a-fA-F]{40}\b/g;

// Base58 alphabet only: no 0, O, I or l. Length is filtered properly by
// the decode below; this range only bounds the candidate set.
const SOLANA_RE = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g;

// A real deployed address is effectively random. An address whose 40 hex
// digits are 30-or-more zeros is a synthetic test fixture (0x...0000a1) or
// an EVM precompile, never a contract whose deployment a reviewer could go
// and verify. Nothing else is filtered by shape: a fixture that looks like
// a real address is indistinguishable from one, and is left to the review.
const MIN_ZEROS_FOR_SYNTHETIC = 30;

function isSyntheticEvm(address) {
  const body = address.slice(2);
  let zeros = 0;
  for (const ch of body) {
    if (ch === "0") {
      zeros++;
    }
  }
  return zeros >= MIN_ZEROS_FOR_SYNTHETIC;
}

// Generated, vendored or minified files. An address in any of these is
// not something a reviewer can verify by reading it, and lockfiles carry
// enough base58-shaped integrity hashes to drown the signal.
const EXCLUDED = [
  /(^|\/)node_modules\//,
  /(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock)$/,
  /\.lock$/,
  /\.snap$/,
  /\.min\.(js|css)$/,
  /\.map$/,
  /\.(png|jpe?g|gif|webp|avif|ico|svg|pdf|woff2?|ttf|eot|zip|gz|wasm)$/i,
];

function isExcluded(path) {
  return EXCLUDED.some((re) => re.test(path));
}

// Returns the decoded byte length, or null when the string is not base58.
function base58ByteLength(s) {
  const bytes = [];
  for (const ch of s) {
    const value = BASE58.indexOf(ch);
    if (value < 0) {
      return null;
    }
    let carry = value;
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  let leadingZeros = 0;
  for (const ch of s) {
    if (ch !== "1") {
      break;
    }
    leadingZeros++;
  }
  return leadingZeros + bytes.length;
}

function git(args) {
  return execFileSync("git", args, {
    encoding: "utf8",
    maxBuffer: 512 * 1024 * 1024,
  });
}

function parseArgs(argv) {
  const args = { base: "origin/staging", head: "HEAD", json: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--base") {
      args.base = argv[++i];
    } else if (argv[i] === "--head") {
      args.head = argv[++i];
    } else if (argv[i] === "--json") {
      args.json = true;
    }
  }
  return args;
}

// True when the literal already appears anywhere in the base tree. Case
// insensitive so a checksummed address does not read as new against the
// lowercase form of itself.
//
// Cached per address: the same address commonly appears in the protocol
// definition, its golden file, its test and its doc page, and each lookup
// is a full-tree grep.
const baseLookupCache = new Map();

function existsOnBase(literal, base) {
  const key = literal.toLowerCase();
  const cached = baseLookupCache.get(key);
  if (cached !== undefined) {
    return cached;
  }
  let found;
  try {
    git(["grep", "--quiet", "-I", "-i", "-F", literal, base]);
    found = true;
  } catch {
    found = false;
  }
  baseLookupCache.set(key, found);
  return found;
}

function scan(diff) {
  const findings = [];
  let path = null;
  let lineNumber = 0;

  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) {
      const target = line.slice(4).trim();
      path = target === "/dev/null" ? null : target.replace(/^b\//, "");
      continue;
    }
    if (line.startsWith("@@")) {
      const match = /^@@ -\S+ \+(\d+)/.exec(line);
      lineNumber = match ? Number(match[1]) : 0;
      continue;
    }
    if (!line.startsWith("+") || line.startsWith("+++")) {
      continue;
    }

    const content = line.slice(1);
    if (path && !isExcluded(path)) {
      for (const match of content.matchAll(EVM_RE)) {
        if (!isSyntheticEvm(match[0])) {
          findings.push({
            path,
            line: lineNumber,
            chain: "evm",
            address: match[0],
          });
        }
      }
      for (const match of content.matchAll(SOLANA_RE)) {
        if (base58ByteLength(match[0]) === 32) {
          findings.push({
            path,
            line: lineNumber,
            chain: "solana",
            address: match[0],
          });
        }
      }
    }
    lineNumber++;
  }

  return findings;
}

const args = parseArgs(process.argv.slice(2));
const diff = git([
  "diff",
  "--unified=0",
  "--no-color",
  `${args.base}...${args.head}`,
]);

// One row per address per file: an address repeated on many lines of the
// same file is one thing to verify, but the same address in the protocol
// definition and in a doc page is worth showing in both places.
const seen = new Set();
const findings = [];
for (const finding of scan(diff)) {
  const key = `${finding.path}:${finding.address.toLowerCase()}`;
  if (seen.has(key)) {
    continue;
  }
  seen.add(key);
  if (existsOnBase(finding.address, args.base)) {
    continue;
  }
  findings.push(finding);
}

if (args.json) {
  console.log(JSON.stringify(findings, null, 2));
} else {
  for (const f of findings) {
    console.log(`${f.path}:${f.line} ${f.chain} ${f.address}`);
  }
}

process.exit(0);
