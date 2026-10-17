import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { dbEnv } from "../config/env.js";
import * as schema from "./schema/index.js";

type Db = ReturnType<typeof drizzle<typeof schema>>;

let client: postgres.Sql | undefined;
let db: Db | undefined;

export function getDb(): Db {
  if (!db) {
    client = postgres(dbEnv().DATABASE_URL, {
      prepare: false,
      max: 1,
      idle_timeout: 5,
      connect_timeout: 10,
    });
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
