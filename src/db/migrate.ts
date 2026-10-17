import { existsSync } from "node:fs";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

export const MIGRATIONS_FOLDER = "drizzle";

export interface MigrationTableOptions {
  migrationsSchema?: string;
  migrationsTable?: string;
}

export async function runMigrations(
  url: string,
  folder = MIGRATIONS_FOLDER,
  tableOptions: MigrationTableOptions = {},
): Promise<boolean> {
  if (!existsSync(join(folder, "meta", "_journal.json"))) return false;
  const client = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
  try {
    await migrate(drizzle(client), { migrationsFolder: folder, ...tableOptions });
    return true;
  } finally {
    await client.end({ timeout: 5 });
  }
}
