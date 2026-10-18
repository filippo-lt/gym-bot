import type { Db } from "../db/seed-plan.js";

export type { Db };
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
/** A database or an open transaction. */
export type Q = Db | Tx;
