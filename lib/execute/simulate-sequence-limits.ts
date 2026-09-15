/**
 * Kept apart from the simulator so the request validator can import the limit
 * without pulling in ethers and the server-only execution path.
 */
export const MAX_SEQUENCE_CALLS = 10;
