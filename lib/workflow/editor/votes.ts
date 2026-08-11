export const VOTE_DIRECTIONS = { upvote: 1, downvote: -1 } as const;
export type VoteDirection = keyof typeof VOTE_DIRECTIONS;

const VALID_DIRECTIONS = new Set<string>(Object.keys(VOTE_DIRECTIONS));

export function isValidDirection(value: unknown): value is VoteDirection {
  return typeof value === "string" && VALID_DIRECTIONS.has(value);
}
