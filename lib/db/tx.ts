import type { db } from "./index";

/** The handle a db.transaction callback receives. */
export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
