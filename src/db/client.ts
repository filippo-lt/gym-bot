import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { dbEnv } from "../config/env.js";
import * as schema from "./schema/index.js";

export type Db = ReturnType<typeof drizzle<typeof schema>>;

let client: postgres.Sql | undefined;
let db: Db | undefined;

export function getDb(): Db {
  if (!db) {
    // max_pipeline is a postgres-js runtime option missing from its type definitions.
    const options: postgres.Options<Record<string, never>> & { max_pipeline: number } = {
      prepare: false,
      max: 1,
      // Supabase's transaction pooler can hang on pipelined queries (concurrent queries on one
      // connection). 0 = strictly one query in flight; local Postgres never shows this.
      max_pipeline: 0,
      idle_timeout: 5,
      connect_timeout: 10,
    };
    client = postgres(dbEnv().DATABASE_URL, options);
    db = drizzle(client, { schema });
  }
  return db;
}

export async function closeDb(): Promise<void> {
  const current = client;
  client = undefined;
  db = undefined;
  await current?.end({ timeout: 5 });
}
