import { runMigrations } from "../../src/db/migrate.js";
import { testDatabaseUrl } from "./constants.js";

export default async function setup(): Promise<void> {
  await runMigrations(testDatabaseUrl());
}
