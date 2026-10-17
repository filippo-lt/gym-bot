import { runMigrations } from "../../src/db/migrate.js";
import { testDatabaseUrl } from "./constants.js";

export default async function setup(): Promise<void> {
  // testDatabaseUrl() throws unless the target is a local *_test database.
  await runMigrations(testDatabaseUrl());
}
