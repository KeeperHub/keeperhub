// Human-readable display-name generator for wallet accounts. Audit trails
// and the activity feed should never surface a raw `0x...` address, so every
// wallet user gets a friendly two-word handle (e.g. "Swift Falcon") both as a
// server-side default at signup and as suggestions in the rename modal.

const ADJECTIVES = [
  "Swift",
  "Calm",
  "Bright",
  "Bold",
  "Brave",
  "Clever",
  "Quiet",
  "Lucky",
  "Noble",
  "Sunny",
  "Witty",
  "Eager",
  "Gentle",
  "Keen",
  "Lively",
  "Merry",
  "Nimble",
  "Proud",
  "Sharp",
  "Steady",
] as const;

const NOUNS = [
  "Falcon",
  "Otter",
  "Badger",
  "Comet",
  "Cypress",
  "Ember",
  "Fox",
  "Harbor",
  "Heron",
  "Lynx",
  "Maple",
  "Meadow",
  "Orbit",
  "Panther",
  "Quartz",
  "Raven",
  "River",
  "Summit",
  "Tiger",
  "Willow",
] as const;

function pick<T>(items: readonly T[]): T {
  return items[Math.floor(Math.random() * items.length)];
}

export function generateHandle(): string {
  return `${pick(ADJECTIVES)} ${pick(NOUNS)}`;
}

// Two distinct suggestions for the rename modal.
export function generateHandlePair(): [string, string] {
  const first = generateHandle();
  let second = generateHandle();
  while (second === first) {
    second = generateHandle();
  }
  return [first, second];
}
